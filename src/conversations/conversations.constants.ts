/**
 * The two Permission keys that legitimately gate the SAME Conversation
 * read routes (list/get/status/assign/tag/message/page-visits), just with a
 * different result scope — see `ConversationsService`'s class doc comment.
 * Shared between `ConversationsController` (single-Site), Phase 2's
 * `CombinedConversationsController` (`GET /conversations?combined=true`,
 * FR-P2-SITE-01–04), and `RealtimeGateway` so the exact same pair is never
 * hand-duplicated in three places and drifts.
 */
export const CONVERSATION_VIEW_PERMISSIONS = [
  'conversations.view_own',
  'conversations.view_site',
] as const;
