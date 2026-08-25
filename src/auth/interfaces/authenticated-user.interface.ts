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
  // `GET /auth/me` can hand the frontend the caller's current
  // desktop/sound preferences on login/resume with no separate round-trip;
  // `MeController`'s own PATCH is still the only way to change it.
  notificationPreferences: { desktopEnabled: boolean; soundEnabled: boolean };
}
