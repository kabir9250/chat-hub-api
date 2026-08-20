/**
 * pageCategory derivation (SRS §4.4a `PageVisit.pageCategory`) — the choice
 * flagged by the task as needing a decision + a note in PROGRESS.md.
 *
 * Chosen rule: the first non-empty path segment, lowercased
 * ("/pricing/enterprise" -> "pricing", "/" -> "home"). Chosen over reusing
 * Trigger matchType/matchValue (Session 5, `src/triggers/`) because
 * Triggers are a sparse, admin-curated rule set meant to answer "does THIS
 * specific page deserve a proactive nudge" — most pages on a real site
 * match zero Triggers, which would leave `pageCategory` null for nearly
 * every PageVisit and make FR-RPT-08's time-per-page-category report
 * mostly empty. A pure, path-derived rule instead guarantees a (reasonably
 * meaningful) category for every PageVisit with zero admin configuration
 * required — simpler option, per the task's own "pick the simpler one"
 * instruction.
 *
 * Deliberately a pure function with no DB access (same shape as
 * AttributionService's derivation helpers, Session 6) so Session 13's
 * analytics aggregation — or anything else that needs to categorize a raw
 * URL outside of PageVisitsService — can import it directly rather than
 * re-deriving the rule.
 *
 * "Configurable" per the task's wording just means this is the one place
 * the rule lives, easy to swap for something admin-configurable later
 * (e.g. a Site-level path-to-category mapping) without touching any
 * caller — not built as an actual admin feature this session, out of scope.
 */
export function derivePageCategory(pageUrl: string): string | null {
  try {
    const url = new URL(pageUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return 'home';
    return decodeURIComponent(segments[0]).toLowerCase();
  } catch {
    // Not a parseable absolute URL — leave uncategorized rather than guess.
    return null;
  }
}
