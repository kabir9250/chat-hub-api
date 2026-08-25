/**
 * Visit-session boundary for a Visitor's PageVisit trail — SRS §2.2
 * (Phase 2): "Visitor path and time-on-site are both derived from the
 * existing PageVisit collection ... no new schema needed." PageVisit has no
 * explicit visit/session id (`database/schemas/page-visit.schema.ts`), so
 * there's nothing to query by directly — a visit boundary has to be
 * *derived*.
 *
 * Chosen rule: a gap of more than `CURRENT_VISIT_GAP_MINUTES` between one
 * PageVisit ending (`exitedAt`, or `enteredAt` if it's the one still open)
 * and the next one starting (`enteredAt`) is what separates one visit
 * session from an earlier, separate one — the same session-timeout
 * heuristic every mainstream web-analytics tool (GA, etc.) uses. Nothing in
 * the SRS mandates an exact number; 30 minutes is that common default.
 *
 * Session P2-5 redesign (direct user feedback, two rounds) — this file used
 * to ALSO back a Conversation's own "Visitor path" directly
 * (`extractCurrentVisit`/`findVisitAt`, an earlier version of this
 * function): two real Conversations happening only minutes apart landed in
 * the same gap-derived group and ended up sharing an identical page trail,
 * which was wrong. The FIRST fix tried bounding a Conversation's path
 * purely by its *adjacent Conversations* instead — but that broke a
 * different, equally real case the user's follow-up spec walked through
 * explicitly: a Visitor's first-ever VISIT with no chat at all, followed by
 * a second visit (days later) that does start a chat — pure
 * Conversation-adjacency has no earlier Conversation to bound against, so
 * it would let the first visit's (chat-less) pages silently bleed into the
 * second visit's own path.
 *
 * The actual rule needs BOTH signals — see
 * `computeVisitorPathLowerBound` below, used by
 * `ConversationsService.computeConversationPath`. `groupIntoVisits` here is
 * still exactly the right tool for "Past visits" (FR-P2-HIST-02) — distinct
 * browsing sessions, with or without a chat ever happening in them — and is
 * now ALSO one of the two inputs a Conversation's own path boundary needs.
 */
export const CURRENT_VISIT_GAP_MINUTES = 30;

/**
 * How far back to look when grouping a Visitor's WHOLE PageVisit history
 * into distinct past visits (Session P2-5, FR-P2-HIST-02) — deliberately a
 * much larger bound than `CURRENT_VISIT_LOOKBACK` (200, "current visit"
 * only needs to look back one visit's worth of pages): grouping needs
 * enough raw rows that pagination over the resulting VISIT groups (not raw
 * rows) doesn't quietly drop a real, older visit just because it fell past
 * a small lookback. 2000 is still a bounded query (same "don't scan a
 * Visitor's entire history unbounded" reasoning `CURRENT_VISIT_LOOKBACK`'s
 * own doc comment gives), generous for any realistic test/demo Visitor.
 */
export const VISIT_HISTORY_LOOKBACK = 2000;

/** One grouped visit — chronological-ascending `pages`, plus the summary
 * fields FR-P2-HIST-02 wants (date, total duration, page count) precomputed
 * so the frontend list doesn't have to re-derive them from `pages` itself. */
export interface VisitGroup<T> {
  pages: T[];
  startedAt: Date;
  endedAt: Date;
  totalDurationSeconds: number;
  /** True when this is the SINGLE most recent group AND its last page has
   * no `exitedAt` yet — i.e. it's the visit genuinely still in progress
   * right now, included here rather than filtered out: FR-P2-HIST-02
   * doesn't say to exclude the current visit, and a Visitor mid-visit still
   * counts as "having a visit" for this list. Deliberately never `true` for
   * any OLDER group even if ITS last page also happens to have a `null`
   * `exitedAt` (legacy data written before `PageVisitsService
   * .recordPageChange`'s own duration cap existed) — an older visit
   * session is definitionally over; a dangling null there is a data
   * artifact, not evidence the Visitor is still on it. */
  isOpen: boolean;
}

/**
 * Groups a Visitor's WHOLE PageVisit history (`recentDesc`, same
 * most-recent-`enteredAt`-first shape `extractCurrentVisit` takes) into
 * distinct visit sessions, using the exact same gap-boundary rule
 * `extractCurrentVisit` uses for just the most recent one — reused, not
 * re-derived (see this file's own class doc comment on why that matters).
 * Groups are returned most-recent-first (group 0 is the same visit
 * `extractCurrentVisit` would return); each group's own `pages` is
 * chronological-ascending, matching `extractCurrentVisit`'s return order.
 */
export function groupIntoVisits<
  T extends {
    enteredAt: Date;
    exitedAt: Date | null;
    durationSeconds: number | null;
  },
>(recentDesc: T[]): VisitGroup<T>[] {
  if (recentDesc.length === 0) return [];

  const gapMs = CURRENT_VISIT_GAP_MINUTES * 60_000;
  const groupsDesc: T[][] = [[recentDesc[0]]];

  for (let i = 1; i < recentDesc.length; i++) {
    const later = recentDesc[i - 1];
    const earlier = recentDesc[i];
    // Direct user feedback, found via a real 32-minute-gap live test that
    // still reported everything as ONE visit — the gap here USED to be
    // measured as `later.enteredAt - earlier.exitedAt`. That looked
    // reasonable (closer to "time since they actually left the last page"
    // than a bare enteredAt-to-enteredAt delta) but is structurally broken
    // for every real PageVisit pair: `PageVisitsService.recordPageChange`
    // is the ONE writer, and it sets a closed-out entry's `exitedAt` to the
    // EXACT SAME `now` it uses as the next entry's `enteredAt`, in the same
    // call. So `earlier.exitedAt` and `later.enteredAt` are, by
    // construction, ALWAYS equal for two real, already-persisted PageVisit
    // rows — making this gap ALWAYS ~0 regardless of how long the Visitor
    // was genuinely away, so a new visit could never be detected at all
    // (Time on site's own duration-capping fix, earlier this session, made
    // this pre-existing flaw newly-and-differently visible when it started
    // giving `exitedAt` an artificial 30-minute cap instead — but the gap
    // formula itself was never sound in the first place). The only
    // genuinely independent signal for "how long between these two
    // navigation events" is `enteredAt`-to-`enteredAt` — each one is set
    // once, at the moment that specific page was actually opened, never
    // derived from or copied onto another row.
    const gap = later.enteredAt.getTime() - earlier.enteredAt.getTime();
    if (gap > gapMs) {
      groupsDesc.push([earlier]);
    } else {
      groupsDesc[groupsDesc.length - 1].push(earlier);
    }
  }

  return groupsDesc.map((groupDesc, index) => {
    const pages = [...groupDesc].reverse();
    const last = pages[pages.length - 1];
    // Only group 0 (most-recent-first — see this function's own doc
    // comment) can legitimately still be "in progress." Direct user
    // feedback ("Time on site"/a past visit's duration reading hours for a
    // long-over visit) — an OLDER group's still-open trailing entry is a
    // data artifact (see `isOpen`'s own doc comment above), not real
    // ongoing activity; letting it count to the real current moment anyway
    // is exactly what produced the wildly-inflated numbers reported.
    // Capped at `CURRENT_VISIT_GAP_MINUTES` past that entry's own
    // `enteredAt` instead — "we don't know exactly when they left, but
    // definitely not still-counting decades later."
    const isLatestGroup = index === 0;
    const totalDurationSeconds = pages.reduce((sum, pv) => {
      if (pv.durationSeconds != null) return sum + pv.durationSeconds;
      const entered = pv.enteredAt.getTime();
      const cap = isLatestGroup
        ? Date.now()
        : entered + CURRENT_VISIT_GAP_MINUTES * 60_000;
      return (
        sum +
        Math.max(0, Math.round((Math.min(Date.now(), cap) - entered) / 1000))
      );
    }, 0);
    return {
      pages,
      startedAt: pages[0].enteredAt,
      endedAt: last.exitedAt ?? last.enteredAt,
      totalDurationSeconds,
      isOpen: isLatestGroup && last.exitedAt == null,
    };
  });
}

/**
 * Which gap-derived `VisitGroup` a given moment (a Conversation's own
 * `startedAt`) falls inside — internal helper for
 * `computeVisitorPathLowerBound` below. Prefers the group whose own
 * `[startedAt, endedAt]` range actually contains `atTime`; falls back to
 * whichever group is chronologically closest (by distance to its nearer
 * edge) if none contains it exactly — PageVisit tracking and Conversation
 * creation are two independent client events, so a few seconds' skew
 * between them is expected, not an error case to reject.
 */
function findVisitGroupAt<T>(
  groups: VisitGroup<T>[],
  atTime: Date,
): VisitGroup<T> | null {
  if (groups.length === 0) return null;
  const t = atTime.getTime();

  const containing = groups.find(
    (g) => g.startedAt.getTime() <= t && t <= g.endedAt.getTime(),
  );
  if (containing) return containing;

  let closest = groups[0];
  let closestDistance = Infinity;
  for (const g of groups) {
    const distance = Math.min(
      Math.abs(g.startedAt.getTime() - t),
      Math.abs(g.endedAt.getTime() - t),
    );
    if (distance < closestDistance) {
      closest = g;
      closestDistance = distance;
    }
  }
  return closest;
}

/**
 * Session P2-5 redesign — the lower bound for a Conversation's own "Visitor
 * path": everything strictly after this point belongs to THIS Conversation
 * (or the visit it happened during); everything at-or-before it belongs to
 * an earlier Conversation's path or to "Past visits". Two candidate signals,
 * the TIGHTER (more recent, i.e. later) of which wins:
 *
 *  (a) The Visitor's PREVIOUS Conversation's own `startedAt` — needed so two
 *      real Conversations that happen close together (within the same
 *      gap-derived visit session — the original bug report: two chats only
 *      minutes apart sharing an identical page trail) don't share/duplicate
 *      the same page list.
 *
 *  (b) The start of whichever gap-derived visit session (`groupIntoVisits`)
 *      this Conversation's own `startedAt` falls inside — needed so an
 *      EARLIER visit session that happened to have no Conversation in it at
 *      all (a Visitor who browsed and left with no chat, then came back
 *      later and DID chat) doesn't bleed its pages into this Conversation's
 *      path just because there was no previous Conversation to bound
 *      against.
 *
 * Taking the max of both closes both gaps: whichever signal is more recent
 * for this specific Conversation is the one that actually matters.
 */
export function computeVisitorPathLowerBound<T extends { enteredAt: Date }>(
  visitGroups: VisitGroup<T>[],
  conversationStartedAt: Date,
  previousConversationStartedAt: Date | null,
): Date {
  const session = findVisitGroupAt(visitGroups, conversationStartedAt);
  const sessionStartMs = session?.startedAt.getTime() ?? 0;
  const previousConversationMs = previousConversationStartedAt?.getTime() ?? 0;
  return new Date(Math.max(sessionStartMs, previousConversationMs));
}
