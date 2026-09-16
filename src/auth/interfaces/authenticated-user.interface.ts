import type {
  IdleTimeoutSettings,
  NotificationPreferences,
} from '../../database/schemas/user.schema';

/**
 * Shape attached to `req.user` by JwtAuthGuard/JwtStrategy for a User
 * (never a Visitor — see JwtPayload doc comment). Identity only: no
 * roles/permissions here yet, that's Session 3's RBAC guard.
 */
export interface AuthenticatedUser {
  userId: string;
  organizationId: string;
  email: string;
  displayName: string;
  fullName: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'away';
  // Phase 2, FR-P2-NOTIF-05/06 — carried on `req.user` (re-loaded from the
  // DB on every request by JwtStrategy, same as every other field here) so
  // `GET /auth/me` can hand the frontend the caller's current per-event
  // notification/sound preferences on login/resume with no separate
  // round-trip; `MeController`'s own PATCH is still the only way to change
  // it. Restructured this session (SRS "12-zendesk-feature-parity" §1.2) —
  // see `NotificationPreferences`'s own doc comment for the full shape.
  notificationPreferences: NotificationPreferences;
  // Personal Settings → Profile (this session, SRS "12-zendesk-feature-
  // parity" §1.1) — same "carried on req.user, re-loaded from the DB on
  // every request" precedent as notificationPreferences above, so
  // `GET /auth/me` can hand the frontend the caller's full self-service
  // profile on login/resume with no separate round-trip. `MeController`'s
  // PATCH .../profile / .../account / .../avatar are still the only way to
  // change any of it.
  tagline?: string;
  avatarUrl?: string;
  preferredLanguage: string;
  chatLimit: number | null;
  skills: string[];
  keyboardShortcutsEnabled: boolean;
  // Session Feature-1c-frontend (SRS "12-zendesk-feature-parity" §1.3) —
  // same "carried on req.user, re-loaded from the DB on every request"
  // precedent as notificationPreferences above, so `GET /auth/me` can hand
  // the frontend the caller's current Idle Timeout settings on login/resume
  // with no separate round-trip. `MeController`'s PATCH
  // .../idle-timeout-settings is still the only way to change it.
  idleTimeoutSettings: IdleTimeoutSettings;
}
