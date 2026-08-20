import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { Site, SiteSchema, Trigger, TriggerSchema } from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { TriggersController } from './triggers.controller';
import { TriggersService } from './triggers.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Trigger.name, schema: TriggerSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [TriggersController],
  providers: [TriggersService],
})
export class TriggersModule {}
