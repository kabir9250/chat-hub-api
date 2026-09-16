import { PresenceStatus } from './presence.service';

/**
 * Site-wide "Account status" aggregation (Feature 2.2 groundwork,
 * `12-zendesk-feature-parity-srs.md` §2.2 — the Trigger condition of the
 * same name): "combine existing per-Agent presence (FR-AGT-02) into one
 * Site-wide online/away/offline value," hierarchical — any Agent online
 * makes the whole Site read as online; else any Agent away makes it read as
 * away; else offline (including the empty-roster case).
 *
 * Pure function over an already-resolved `PresenceStatus[]` — deliberately
 * does NOT resolve "which Users count as this Site's Agents" itself. That
 * resolution is RBAC-shaped (Site access is `RoleAssignment`-based, not a
 * direct `User.siteId`, and different callers may want a different notion
 * of "this Site's Agents" — e.g. routing's Department-scoped candidate list
 * vs. every User with any access to the Site) and belongs with `Trigger`
 * evaluation engine's own Site/Department resolution once that's built, not
 * hardcoded into this reusable aggregation. Callers assemble the status
 * list (e.g. via `PresenceService.getStatus` per candidate userId, same as
 * `pickAgentForRouting`'s existing `isOnline` usage in
 * `ConversationsService`) and pass it in here.
 */
export function aggregateAccountStatus(
  statuses: PresenceStatus[],
): PresenceStatus {
  if (statuses.some((status) => status === 'online')) return 'online';
  if (statuses.some((status) => status === 'away')) return 'away';
  return 'offline';
}
