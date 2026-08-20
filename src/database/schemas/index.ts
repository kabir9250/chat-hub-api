import { ModelDefinition } from '@nestjs/mongoose';

import { Organization, OrganizationSchema } from './organization.schema';
import { Site, SiteSchema } from './site.schema';
import { Department, DepartmentSchema } from './department.schema';
import { User, UserSchema } from './user.schema';
import { Role, RoleSchema } from './role.schema';
import { Visitor, VisitorSchema } from './visitor.schema';
import { Conversation, ConversationSchema } from './conversation.schema';
import { Message, MessageSchema } from './message.schema';
import { WidgetConfig, WidgetConfigSchema } from './widget-config.schema';
import { Trigger, TriggerSchema } from './trigger.schema';
import { Lead, LeadSchema } from './lead.schema';
import { AnalyticsEvent, AnalyticsEventSchema } from './analytics-event.schema';
import { AuditLog, AuditLogSchema } from './audit-log.schema';
import { Counter, CounterSchema } from './counter.schema';
import { PageVisit, PageVisitSchema } from './page-visit.schema';

export * from './organization.schema';
export * from './site.schema';
export * from './department.schema';
export * from './user.schema';
export * from './role.schema';
export * from './visitor.schema';
export * from './conversation.schema';
export * from './message.schema';
export * from './widget-config.schema';
export * from './trigger.schema';
export * from './lead.schema';
export * from './analytics-event.schema';
export * from './audit-log.schema';
export * from './counter.schema';
export * from './page-visit.schema';

/**
 * All Mongoose model definitions for the app, in one place — passed to
 * `MongooseModule.forFeature()` in DatabaseModule and reused as-is by the
 * standalone seed script so both stay in sync automatically.
 */
export const ALL_MODEL_DEFINITIONS: ModelDefinition[] = [
  { name: Organization.name, schema: OrganizationSchema },
  { name: Site.name, schema: SiteSchema },
  { name: Department.name, schema: DepartmentSchema },
  { name: User.name, schema: UserSchema },
  { name: Role.name, schema: RoleSchema },
  { name: Visitor.name, schema: VisitorSchema },
  { name: Conversation.name, schema: ConversationSchema },
  { name: Message.name, schema: MessageSchema },
  { name: WidgetConfig.name, schema: WidgetConfigSchema },
  { name: Trigger.name, schema: TriggerSchema },
  { name: Lead.name, schema: LeadSchema },
  { name: AnalyticsEvent.name, schema: AnalyticsEventSchema },
  { name: AuditLog.name, schema: AuditLogSchema },
  { name: Counter.name, schema: CounterSchema },
  { name: PageVisit.name, schema: PageVisitSchema },
];
