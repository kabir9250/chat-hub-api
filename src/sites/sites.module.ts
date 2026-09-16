import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Site, SiteSchema, User, UserSchema } from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { SitesController } from './sites.controller';
import { BusinessHoursController } from './business-hours.controller';
import { SoundNotificationsController } from './sound-notifications.controller';
import { IdleTimeoutController } from './idle-timeout.controller';
import { SitesService } from './sites.service';
import { BusinessHoursService } from './business-hours.service';
import { SoundNotificationsService } from './sound-notifications.service';
import { IdleTimeoutService } from './idle-timeout.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Site.name, schema: SiteSchema },
      { name: User.name, schema: UserSchema },
    ]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [
    SitesController,
    BusinessHoursController,
    SoundNotificationsController,
    IdleTimeoutController,
  ],
  providers: [
    SitesService,
    BusinessHoursService,
    SoundNotificationsService,
    IdleTimeoutService,
  ],
})
export class SitesModule {}
