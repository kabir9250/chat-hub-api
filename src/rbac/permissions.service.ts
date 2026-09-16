import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import { User, UserDocument } from '../database/schemas/user.schema';
import { Role, RoleDocument } from '../database/schemas/role.schema';
import { Site, SiteDocument } from '../database/schemas/site.schema';
import { PermissionKey } from './permission.catalog';

export interface EffectivePermissionsSummary {
  /** Permissions the User holds Organization-wide (from ORGANIZATION-scoped assignments only). */
  organizationPermissions: PermissionKey[];
  /**
   * Effective (unioned) permissions per Site the User has ANY access to —
   * i.e. every Site in the Organization if they hold an ORGANIZATION-scoped
   * assignment, plus any specific Site(s) from SITE-scoped assignments.
   * Keyed by Site id (string).
   */
  sitePermissions: Record<string, PermissionKey[]>;
  /**
   * This session's addition — human-readable Site names for exactly the
   * Sites in `sitePermissions` above (same keys), so the Admin Panel/Agent
   * Console Site switchers can show a real name instead of a shortened id.
   * Deliberately handed out here rather than requiring a separate
   * `GET /sites` call: that endpoint is gated on `sites.view`/`sites.manage`
   * ("Owner-level in Phase 1"), which most Roles that use a Site switcher
   * (Manager/Supervisor/Agent) never hold — this is not a security
   * boundary, just the same name a `sites.view` holder would see for a
   * Site the caller can already reach some other way.
   */
  siteNames: Record<string, string>;
  /**
   * This session's addition — the Site's configured `domains[]` (the "Site
   * URL(s)" field in the Admin Panel's Site form), same keys as `siteNames`.
   * Lets the Agent Console's "Simulate visitor" button (Visitors tab) open
   * the actual site in a new tab the way Zendesk's does, without requiring
   * `sites.view`/`sites.manage` (same rationale as `siteNames` above — this
   * is not a security boundary). Empty array when the Site has no domain
   * configured yet; the frontend disables the button in that case rather
   * than opening a blank/invalid URL.
   */
  siteDomains: Record<string, string[]>;
}

/**
 * PermissionsService — FR-RBAC-06.
 *
 * The single place that turns "a User + a target Site (or org-wide)" into
 * an effective permission set. Nothing else in the codebase should read
 * `User.roleAssignments` / `Role.permissions` directly to make an access
 * decision — go through this service (or, for guarding a route/WS handler,
 * through `PermissionGuard`, which itself is built on this service).
 *
 * Effective permissions on a Site = union of:
 *   (a) permissions from any ORGANIZATION-scoped Role Assignment the User holds, plus
 *   (b) permissions from any SITE-scoped Role Assignment the User holds for that Site.
 * A User with no applicable assignment has no access (empty set) — there is
 * no implicit "owner"/superuser shortcut anywhere in this file. Owner works
 * purely because the seeded Owner Role's `permissions` array contains every
 * catalog key at ORGANIZATION scope — if that ever stops being true, this
 * code has no special case to fall back on, by design.
 */
@Injectable()
export class PermissionsService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
  ) {}

  /**
   * Effective permissions for `userId` on `siteId`. Pass `siteId: null` (or
   * omit) for an Organization-wide check (only ORGANIZATION-scoped
   * assignments apply) — this is what `@RequirePermission(key, { siteSource: 'none' })`
   * resolves to, and it's how `roles.manage` / `role_assignments.manage`
   * (inherently org-level actions) get checked.
   */
  async getEffectivePermissions(
    userId: string | Types.ObjectId,
    siteId?: string | Types.ObjectId | null,
  ): Promise<PermissionKey[]> {
    const user = await this.userModel.findById(userId).lean().exec();
    if (!user) {
      return [];
    }

    const siteIdStr = siteId ? siteId.toString() : null;
    const applicableRoleIds = new Set<string>();
    for (const assignment of user.roleAssignments ?? []) {
      if (assignment.scopeType === 'ORGANIZATION') {
        applicableRoleIds.add(assignment.roleId.toString());
      } else if (
        assignment.scopeType === 'SITE' &&
        siteIdStr &&
        assignment.siteId?.toString() === siteIdStr
      ) {
        applicableRoleIds.add(assignment.roleId.toString());
      }
    }

    if (applicableRoleIds.size === 0) {
      return [];
    }

    const roles = await this.roleModel
      .find({ _id: { $in: [...applicableRoleIds] } })
      .lean()
      .exec();

    const union = new Set<string>();
    for (const role of roles) {
      for (const key of role.permissions) {
        union.add(key);
      }
    }
    return [...union] as PermissionKey[];
  }

  /** Convenience wrapper: does `userId` have `permission` on `siteId` (or org-wide if omitted)? */
  async hasPermission(
    userId: string | Types.ObjectId,
    permission: PermissionKey,
    siteId?: string | Types.ObjectId | null,
  ): Promise<boolean> {
    const effective = await this.getEffectivePermissions(userId, siteId);
    return effective.includes(permission);
  }

  /**
   * FR-AUTH-06: everything `GET /auth/me` needs to hand the frontend so it
   * can render/hide UI without re-deriving RBAC logic client-side. Not a
   * security boundary itself (§6.3) — every real check still goes through
   * PermissionGuard server-side.
   */
  async getEffectivePermissionsSummary(
    userId: string | Types.ObjectId,
  ): Promise<EffectivePermissionsSummary> {
    const user = await this.userModel.findById(userId).lean().exec();
    if (!user) {
      return {
        organizationPermissions: [],
        sitePermissions: {},
        siteNames: {},
        siteDomains: {},
      };
    }

    const organizationPermissions = await this.getEffectivePermissions(
      userId,
      null,
    );

    const siteScopedIds = new Set(
      (user.roleAssignments ?? [])
        .filter((a) => a.scopeType === 'SITE' && a.siteId)
        .map((a) => a.siteId!.toString()),
    );
    const hasOrgAssignment = (user.roleAssignments ?? []).some(
      (a) => a.scopeType === 'ORGANIZATION',
    );

    const siteIds = new Set(siteScopedIds);
    if (hasOrgAssignment) {
      // An ORGANIZATION-scoped assignment grants (at least) that Role's
      // permissions on every Site in the Organization, so every Site
      // "has access" for this summary, not just the Sites with an explicit
      // SITE-scoped assignment.
      const sites = await this.siteModel
        .find({ organizationId: user.organizationId })
        .select('_id')
        .lean()
        .exec();
      for (const site of sites) {
        siteIds.add(site._id.toString());
      }
    }

    const sitePermissions: Record<string, PermissionKey[]> = {};
    for (const siteId of siteIds) {
      sitePermissions[siteId] = await this.getEffectivePermissions(
        userId,
        siteId,
      );
    }

    // One extra lookup for the names of exactly the Sites landing in
    // `sitePermissions` above (see that field's doc comment on
    // `EffectivePermissionsSummary`) — covers both the ORGANIZATION-scoped
    // branch (which only selected `_id` above) and the SITE-scoped-only
    // branch (which has ids but never fetched the documents at all) in one
    // query rather than two.
    const siteDocs = await this.siteModel
      .find({ _id: { $in: [...siteIds] } })
      .select('name domains')
      .lean()
      .exec();
    const siteNames: Record<string, string> = {};
    const siteDomains: Record<string, string[]> = {};
    for (const doc of siteDocs) {
      siteNames[doc._id.toString()] = doc.name;
      siteDomains[doc._id.toString()] = doc.domains ?? [];
    }

    return { organizationPermissions, sitePermissions, siteNames, siteDomains };
  }

  /**
   * "Does `userId` have ANY access to `siteId`" — an ORGANIZATION-scoped
   * Role Assignment, or a SITE-scoped one for that specific Site. This is a
   * coarser question than `hasPermission` (which key-checks); it answers
   * "does this User belong to this Site at all," which several modules
   * need when validating a reference to *another* User (e.g. "is the Agent
   * I'm about to assign this Conversation to actually on this Site").
   *
   * Promoted here in Session 7 (Conversations) from a private helper that
   * was already duplicated in `UsersService`/`DepartmentsService` (Session
   * 4 flagged exactly this: "if a third module needs the same check,
   * consider promoting it into PermissionsService") — those two call
   * sites still have their own private copies (unchanged, to keep this
   * session's diff scoped to what it touches), but any new module should
   * call this one instead of writing a fourth copy.
   */
  async isUserOnSite(
    userId: string | Types.ObjectId,
    siteId: string | Types.ObjectId,
  ): Promise<boolean> {
    const user = await this.userModel.findById(userId).lean().exec();
    if (!user) return false;

    const siteIdStr = siteId.toString();
    return (user.roleAssignments ?? []).some(
      (a) =>
        a.scopeType === 'ORGANIZATION' ||
        (a.scopeType === 'SITE' && a.siteId?.toString() === siteIdStr),
    );
  }

  /**
   * Phase 2, FR-P2-SITE-01–04 — the server-side Site-set resolution every
   * "combined/All Sites" endpoint (Conversations list, History search,
   * Visitors list) and the WebSocket gateway's `agent:join_combined`
   * handler are built on. Returns exactly the Sites where `userId` holds AT
   * LEAST ONE of `anyOfPermissions` — via an ORGANIZATION-scoped assignment
   * (covers every Site) or a SITE-scoped one for that specific Site — plus,
   * for each, which of the requested keys actually matched (so a caller can
   * tell a `view_site` Site apart from a `view_own`-only one and narrow its
   * own query accordingly, the same way `ConversationsService.resolveScope`
   * already does for a single Site).
   *
   * Deliberately reuses `getEffectivePermissionsSummary` rather than a new
   * query — this IS "the caller's effective permissions" (FR-P2-SITE-02),
   * computed the exact same way `GET /auth/me` computes them. Never accepts
   * a Site list from the caller; the returned set is the only thing a
   * "combined" endpoint is allowed to treat as the caller's authorized Sites.
   */
  async getAuthorizedSites(
    userId: string | Types.ObjectId,
    anyOfPermissions: PermissionKey[],
  ): Promise<Array<{ siteId: string; permissions: PermissionKey[] }>> {
    const summary = await this.getEffectivePermissionsSummary(userId);
    const results: Array<{ siteId: string; permissions: PermissionKey[] }> = [];
    for (const [siteId, permissions] of Object.entries(
      summary.sitePermissions,
    )) {
      const matched = permissions.filter((p) => anyOfPermissions.includes(p));
      if (matched.length > 0) {
        results.push({ siteId, permissions: matched });
      }
    }
    return results;
  }

  /**
   * FR-RBAC-09(b) — lockout guard. Returns true if, after excluding
   * `excludeAssignment` (an in-flight revoke) and/or substituting
   * `simulateRole` (an in-flight Role permissions edit), zero Users in the
   * Organization would still hold `permission` via an ORGANIZATION-scoped
   * Role Assignment.
   *
   * Deliberately generic on `permission` (not hardcoded to
   * `role_assignments.manage`) even though that's the only caller today —
   * the logic is identical for any "don't let the Organization lock itself
   * out of some org-level capability" rule.
   */
  async wouldOrphanOrganizationPermission(
    organizationId: string | Types.ObjectId,
    permission: PermissionKey,
    options: {
      excludeAssignment?: { userId: string; assignmentId: string };
      simulateRole?: { roleId: string; permissions: string[] };
    } = {},
  ): Promise<boolean> {
    const users = await this.userModel.find({ organizationId }).lean().exec();

    const roleIds = new Set<string>();
    for (const user of users) {
      for (const assignment of user.roleAssignments ?? []) {
        if (assignment.scopeType === 'ORGANIZATION') {
          roleIds.add(assignment.roleId.toString());
        }
      }
    }
    const roles = await this.roleModel
      .find({ _id: { $in: [...roleIds] } })
      .lean()
      .exec();
    const roleGrantsPermission = new Map<string, boolean>(
      roles.map((r) => [r._id.toString(), r.permissions.includes(permission)]),
    );
    if (options.simulateRole) {
      roleGrantsPermission.set(
        options.simulateRole.roleId,
        options.simulateRole.permissions.includes(permission),
      );
    }

    for (const user of users) {
      for (const assignment of user.roleAssignments ?? []) {
        if (assignment.scopeType !== 'ORGANIZATION') continue;
        if (
          options.excludeAssignment &&
          user._id.toString() === options.excludeAssignment.userId &&
          assignment._id?.toString() === options.excludeAssignment.assignmentId
        ) {
          continue;
        }
        if (roleGrantsPermission.get(assignment.roleId.toString())) {
          return false; // found at least one remaining holder
        }
      }
    }
    return true; // no holder left
  }
}
