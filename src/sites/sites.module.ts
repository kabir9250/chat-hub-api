import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Site, SiteSchema } from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { SitesController } from './sites.controller';
import { BusinessHoursController } from './business-hours.controller';
import { SoundNotificationsController } from './sound-notifications.controller';
import { SitesService } from './sites.service';
import { BusinessHoursService } from './business-hours.service';
import { SoundNotificationsService } from './sound-notifications.service';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Site.name, schema: SiteSchema }]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [
    SitesController,
    BusinessHoursController,
    SoundNotificationsController,
  ],
  providers: [SitesService, BusinessHoursService, SoundNotificationsService],
})
export class SitesModule {}
