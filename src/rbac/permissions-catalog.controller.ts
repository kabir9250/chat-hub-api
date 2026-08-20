import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';

import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PERMISSION_CATALOG, PERMISSION_MODULES } from './permission.catalog';

/**
 * Read-only Permission catalog — FR-RBAC-02. Static, fixed, not
 * user-editable (see permission.catalog.ts), so there's nothing to gate
 * behind a specific Permission key beyond "is this a real logged-in User":
 * the catalog itself carries no data about the caller's own Organization
 * and isn't sensitive — it's the fixed menu the Admin Panel's Roles &
 * Permissions screen (FR-RBAC-08) renders checkboxes against. Real access
 * control still happens on the Roles/Role-Assignment endpoints themselves.
 */
@ApiTags('Permissions Catalog')
@ApiBearerAuth('access-token')
@Controller('permissions')
@UseGuards(JwtAuthGuard)
export class PermissionsCatalogController {
  @ApiOperation({
    summary: 'List every permission key in the system',
    description:
      'Any authenticated User can read this — it is static reference data, not per-Organization.',
  })
  @Get()
  list() {
    return { modules: PERMISSION_MODULES, permissions: PERMISSION_CATALOG };
  }
}
