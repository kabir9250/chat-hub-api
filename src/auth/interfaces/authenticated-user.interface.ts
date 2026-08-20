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
}
