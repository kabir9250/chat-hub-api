import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Site,
  SiteSchema,
  Trigger,
  TriggerSchema,
  User,
  UserSchema,
  WidgetConfig,
  WidgetConfigSchema,
} from '../database/schemas';
import { RbacModule } from '../rbac/rbac.module';
import { PresenceModule } from '../realtime/presence.module';
import { WidgetBootstrapController } from './widget-bootstrap.controller';
import { WidgetBootstrapService } from './widget-bootstrap.service';

// Deliberately does NOT import AuthModule — no JwtAuthGuard/VisitorAuthGuard
// anywhere in this module, the controller is public by design (see
// WidgetBootstrapController). RbacModule/PresenceModule ARE imported (new
// this session, for GET :siteId/status) — but only for their plain
// services (PermissionsService/PresenceService), never a guard.
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Site.name, schema: SiteSchema },
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
      { name: Trigger.name, schema: TriggerSchema },
      { name: User.name, schema: UserSchema },
    ]),
    RbacModule,
    PresenceModule,
  ],
  controllers: [WidgetBootstrapController],
  providers: [WidgetBootstrapService],
})
export class WidgetBootstrapModule {}
