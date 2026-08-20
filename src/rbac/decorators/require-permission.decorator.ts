import { SetMetadata } from '@nestjs/common';

import { PermissionKey } from '../permission.catalog';

export const PERMISSION_METADATA_KEY = 'rbac:required_permission';

/** Where PermissionGuard should read the target Site id from. */
export type PermissionSiteSource = 'param' | 'body' | 'query' | 'none';

export interface RequirePermissionOptions {
  /**
   * Defaults to `'param'` (the common case: routes like `/sites/:siteId/...`).
   * Use `'body'` for e.g. a create endpoint whose Site id is in the JSON
   * payload, `'query'` for a `?siteId=` filter, or `'none'` for a check that
   * has no Site at all — an Organization-wide permission such as
   * `roles.manage` or `role_assignments.manage`.
   */
  siteSource?: PermissionSiteSource;
  /** Field name to read within that source. Defaults to `'siteId'`. */
  siteField?: string;
}

export interface RequirePermissionMetadata {
  /**
   * ANY of these keys is sufficient to pass the guard (normalized to an
   * array even for the common single-key case). Added in Session 7
   * (Conversations) for `conversations.view_own` / `conversations.view_site`
   * — both gate the SAME list/get routes, just with a different result
   * scope, which is a genuine "requires one of several keys" case the
   * original single-key design didn't anticipate. Per Session 3's own
   * guidance ("if a check doesn't fit the existing options, extend the
   * decorator/guard, don't bypass it") this is an additive extension, not a
   * new parallel mechanism — every existing single-key call site keeps
   * working unchanged.
   */
  permission: PermissionKey[];
  siteSource: PermissionSiteSource;
  siteField: string;
}

/**
 * Declares the single Permission key (from the fixed catalog in
 * `permission.catalog.ts`) required to reach a route or WebSocket handler,
 * per FR-RBAC-07 / FR-AUTH-04 — this is the ONLY way any module may gate
 * access to Site- or Organization-scoped data. Never hand-roll a role/
 * permission check (e.g. `if (user.role === 'admin')`) anywhere else.
 *
 * Must be paired with `PermissionGuard` (and an identity guard that runs
 * first and attaches the caller to the request/socket):
 *
 * ```ts
 * @UseGuards(JwtAuthGuard, PermissionGuard)
 * @RequirePermission('conversations.assign')       // siteId from route param :siteId (default)
 * @Post('sites/:siteId/conversations/:id/assign')
 * assign(...) { ... }
 *
 * @RequirePermission('widget_config.manage', { siteSource: 'body' })
 * @Patch('widget-config')
 * update(@Body() dto: UpdateWidgetConfigDto) { ... }  // dto.siteId
 *
 * @RequirePermission('roles.manage', { siteSource: 'none' })  // org-wide, no Site involved
 * @Post('roles')
 * create(...) { ... }
 *
 * @RequirePermission(['conversations.view_own', 'conversations.view_site'])  // either is enough to pass; the service decides result scope
 * @Get('sites/:siteId/conversations')
 * findAll(...) { ... }
 * ```
 *
 * Every later session's controllers/gateways call this same decorator by
 * name — see PROGRESS.md ("Session 3") for the full contract, and
 * ("Session 7") for the array/ANY-of extension.
 */
export const RequirePermission = (
  permission: PermissionKey | PermissionKey[],
  options: RequirePermissionOptions = {},
) =>
  SetMetadata<string, RequirePermissionMetadata>(PERMISSION_METADATA_KEY, {
    permission: Array.isArray(permission) ? permission : [permission],
    siteSource: options.siteSource ?? 'param',
    siteField: options.siteField ?? 'siteId',
  });
