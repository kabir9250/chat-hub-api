import type {
  ConversationStatus,
  ConversationSubmissionChannel,
  DropSide,
  ServedOutcome,
} from '../database/schemas/conversation.schema';

/** How long a side may stay disconnected before the chat counts as dropped. */
export const DROP_GRACE_MS = 2 * 60 * 1000;

export interface ServedOutcomeInput {
  submissionChannel: ConversationSubmissionChannel;
  status: ConversationStatus;
  visitorMsgCount: number;
  agentMsgCount: number;
  droppedAt: Date | null;
  droppedBy: DropSide | null;
}

/**
 * "Chats served" bucket for the advanced History filter. Order matters:
 *  1. Offline Contact Form submissions are their own bucket.
 *  2. Missed — visitor wrote, no Agent ever replied, and the visitor is gone
 *     (chat closed, or the visitor's connection was dropped).
 *  3. Unresponsive — an Agent wrote, the visitor never did, and the chat is
 *     over (closed or dropped).
 *  4. Dropped — either side's connection was lost and never restored,
 *     regardless of whether the chat was closed afterwards.
 *  5. Completed — both sides spoke and the chat was closed without a drop.
 * Anything else is still in progress → null.
 */
export function computeServedOutcome(c: ServedOutcomeInput): ServedOutcome | null {
  if (c.submissionChannel === 'offline') return 'offline_form';

  const over = c.status === 'closed' || c.droppedAt != null;

  if (
    c.visitorMsgCount > 0 &&
    c.agentMsgCount === 0 &&
    (c.status === 'closed' || c.droppedBy === 'visitor')
  ) {
    return 'missed';
  }
  if (c.agentMsgCount > 0 && c.visitorMsgCount === 0 && over) {
    return 'unresponsive';
  }
  if (c.droppedAt != null) return 'dropped';
  if (c.visitorMsgCount > 0 && c.agentMsgCount > 0 && c.status === 'closed') {
    return 'completed';
  }
  return null;
}
