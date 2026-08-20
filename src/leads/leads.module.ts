import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';

import {
  Lead,
  LeadSchema,
  Site,
  SiteSchema,
  Visitor,
  VisitorSchema,
} from '../database/schemas';
import { AuditLogModule } from '../audit-log/audit-log.module';
import { RbacModule } from '../rbac/rbac.module';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Lead.name, schema: LeadSchema },
      { name: Visitor.name, schema: VisitorSchema },
      { name: Site.name, schema: SiteSchema },
    ]),
    AuditLogModule,
    RbacModule,
  ],
  controllers: [LeadsController],
  providers: [LeadsService],
  // VisitorsService calls syncLeadForVisitor() after an edit that sets
  // name/email — exported so VisitorsModule can import this module rather
  // than duplicate the qualification/upsert logic.
  exports: [LeadsService],
})
export class LeadsModule {}
