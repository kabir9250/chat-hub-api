import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  User,
  UserSchema,
  Role,
  RoleSchema,
  Department,
  DepartmentSchema,
  Site,
  SiteSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: User.name, schema: UserSchema },
      { name: Role.name, schema: RoleSchema },
      { name: Department.name, schema: DepartmentSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
    // Pulls in PermissionGuard + PermissionsService — see rbac.module.ts.
    RbacModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
})
export class UsersModule {}
