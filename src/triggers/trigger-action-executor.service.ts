import { Injectable } from '@nestjs/common';
import { Types } from 'mongoose';

import {
  SiteDocument,
  TriggerActionConfig,
  VisitorDocument,
} from '../database/schemas';
import { VisitorsService } from '../visitors/visitors.service';

/** The action types this service knows how to apply. */
const FIELD_WRITE_ACTION_TYPES = new Set([
  'setVisitorName',
  'addTag',
  'removeTag',
  'replaceNote',
  'appendNote',
]);

/**
 * TriggerActionExecutorService — Sessions Feature-2c-simple-actions (the 5
 * direct-field-write actions) and Feature-2c-complex-actions (the 5
 * remaining SRS §2.2 actions: Send message/Set triggered/Wait/Block
 * visitor/Set visitor department). Applies a Trigger's `actions` array, IN
 * ORDER, to an already-loaded Visitor.
 *
 * `applyAll` is now async (was sync under Feature-2c-simple-actions alone)
 * because `wait` has to genuinely suspend the REMAINING actions in the same
 * list without blocking the Node event loop for anything else — a plain
 * `await sleep(ms)` between array iterations does exactly that (Node's
 * single-threaded event loop keeps servicing every other socket/request
 * while this one async call is parked on a timer; nothing else in the
 * process is blocked). See `RealtimeGateway.handleVisitorTriggerActivated`
 * for why this fire-and-forget-after-a-wait shape is safe there (never
 * awaited by the caller, since Wait can legitimately span many seconds and
 * the WS handler itself must return promptly).
 *
 * `showProactiveMessage`/`autoOpenWidget`/`sendConciergeMessage`/
 * `setDepartment` are still NOT executed here — the client-side widget
 * evaluator (`chat-hub-web/src/widget/triggers.ts`/`WidgetApp.tsx`) already
 * runs those the moment it independently evaluates the same match locally
 * (see that file's `applyTriggerActions`), so executing them a second time
 * here would double-apply a visible, user-facing effect. This service only
 * owns the 5 actions that have NO client-side equivalent at all — direct
 * Visitor field writes plus the 5 real server-side side effects Feature-2c-
 * complex-actions adds (`setTriggered`/`wait`/`blockVisitor`/
 * `setVisitorDepartment`; `wait` itself has no field write, it only gates
 * the ones after it). `apply()` no-ops on every other action type so a
 * caller can hand it a Trigger's full, mixed `actions` array unfiltered.
 *
 * Field-write actions still mutate `visitor` in place without saving it
 * themselves — `applyAll`'s caller saves once after every action has run
 * (a `wait` mid-array means the save still can't happen until the whole
 * sequence finishes, so `RealtimeGateway` awaits `applyAll` before its one
 * `visitor.save()`, same "batch several actions into one save" reasoning
 * Feature-2c-simple-actions already established, just now spanning a
 * possible delay too). `blockVisitor` is the one exception — banning has
 * its own dedicated persistence path (`VisitorsService.banFromTrigger`,
 * Feature 2a's exact `BannedEntry` mechanism) that already saves
 * `visitor.isBanned` itself, so it doesn't wait for the caller's later save.
 */
@Injectable()
export class TriggerActionExecutorService {
  constructor(private readonly visitorsService: VisitorsService) {}

  /**
   * Applies every action in `actions`, in array order, to `visitor`
   * (mutated in place for the field-write types — does NOT call
   * `.save()`; that's the caller's responsibility once every matched
   * Trigger's actions have run). A `wait` action pauses before continuing
   * to the NEXT action in this same array — it never affects any other
   * Trigger's actions or any other Visitor/socket being served
   * concurrently.
   */
  async applyAll(
    site: SiteDocument,
    visitor: VisitorDocument,
    actions: TriggerActionConfig[],
  ): Promise<void> {
    for (const action of actions) {
      await this.apply(site, visitor, action);
    }
  }

  /** Applies a single action. No-ops on an action type this service doesn't own (see class doc comment) or a field-write action with no usable value. */
  async apply(
    site: SiteDocument,
    visitor: VisitorDocument,
    action: TriggerActionConfig,
  ): Promise<void> {
    if (action.type === 'wait') {
      const seconds = Number(action.value);
      if (Number.isFinite(seconds) && seconds > 0) {
        await sleep(seconds * 1000);
      }
      return;
    }

    if (action.type === 'setTriggered') {
      visitor.wasTriggered = true;
      return;
    }

    if (action.type === 'setVisitorDepartment') {
      const value = action.value?.trim();
      if (!value || !Types.ObjectId.isValid(value)) return;
      visitor.department = new Types.ObjectId(value);
      return;
    }

    if (action.type === 'blockVisitor') {
      // Feature 2a's exact mechanism, via VisitorsService.banFromTrigger —
      // GUARDRAIL: no parallel ban path. This writes+saves visitor.isBanned
      // and the BannedEntry row itself, independent of the caller's later
      // `visitor.save()` for the OTHER field-write actions in this same
      // list, so a ban this action just wrote is never lost if the caller's
      // save races with something else.
      await this.visitorsService.banFromTrigger(
        site,
        visitor,
        action.value?.trim() || undefined,
      );
      return;
    }

    if (!FIELD_WRITE_ACTION_TYPES.has(action.type)) return;

    const value = action.value?.trim();
    if (!value) return; // DTO/service-layer validation already requires a value for these types; defensive no-op if one somehow reaches here empty.

    switch (action.type) {
      case 'setVisitorName':
        visitor.name = value;
        break;
      case 'addTag':
        if (!visitor.tags.includes(value)) visitor.tags.push(value);
        break;
      case 'removeTag':
        visitor.tags = visitor.tags.filter((t) => t !== value);
        break;
      case 'replaceNote':
        visitor.notes = value;
        break;
      case 'appendNote':
        // `Visitor.notes` (FR-VIS-06) is a single free-text field with no
        // existing multi-entry convention to match (the manual note
        // editor — VisitorsService.updateProfile — just overwrites it
        // wholesale). Separates with a blank line so a Trigger-appended
        // note reads as its own paragraph rather than running on from
        // whatever was there before; an empty starting note just becomes
        // the appended text, no leading separator.
        visitor.notes = visitor.notes ? `${visitor.notes}\n\n${value}` : value;
        break;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
