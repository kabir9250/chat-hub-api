import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import { AuditLog, AuditLogSchema } from '../database/schemas';
import { AuditLogService } from './audit-log.service';

/**
 * Exports AuditLogService so any feature module can inject it and call
 * `record()` — see AuditLogService doc comment for scope of this session.
 */
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
