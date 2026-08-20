import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Site,
  SiteSchema,
  WidgetConfig,
  WidgetConfigSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { WidgetConfigController } from './widget-config.controller';
import { WidgetConfigService } from './widget-config.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: WidgetConfig.name, schema: WidgetConfigSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [WidgetConfigController],
  providers: [WidgetConfigService],
  exports: [WidgetConfigService],
})
export class WidgetConfigModule {}
