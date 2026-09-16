import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  AuditLog,
  AuditLogDocument,
  AuditActorType,
} from '../database/schemas';

export interface RecordAuditLogInput {
  actorType: AuditActorType;
  actorId?: Types.ObjectId | string;
  action: string;
  siteId?: Types.ObjectId | string;
  targetType?: string;
  targetId?: Types.ObjectId | string;
  metadata?: Record<string, unknown>;
}

/**
 * AuditLogService — SRS §5.10 FR-AUTH-05 scaffolding.
 *
 * A generic `record()` method that any module can call to append an
 * audit-trail entry (who / what / when / which Site). This session only
 * calls it from login and visitor-session init, to prove the plumbing
 * end-to-end — later sessions wire it into conversation assignment,
 * bans, config changes, role/permission changes, etc. (per the SRS list).
 *
 * Deliberately fire-and-forget-safe: a logging failure must never break
 * the calling request, so errors are caught and logged, not rethrown.
 *
 * Hardening session addition (SRS §6.7 "key business events — conversation
 * created/closed, agent assigned"; also covers "role/permission changes"
 * and doubles as the "authentication events" log since `auth.login`/
 * `auth.login_failed` are recorded here too): every successful `record()`
 * call ALSO emits one structured JSON log line (via the app's
 * `JsonLoggerService`, see main.ts) in addition to the DB write. This is
 * the single choke point every mutating action across the whole app already
 * calls — role/permission changes, user/department CRUD, conversation
 * lifecycle (created/assigned/status/tagged/rated), widget config/trigger
 * edits, visitor ban/unban, business hours — so this one change gives every
 * one of those a structured console log line too, with no per-call-site
 * changes needed anywhere else. The DB write remains the durable, queryable
 * audit trail (FR-AUTH-05); this log line is the "watch it happen live /
 * ship it to a log aggregator" half of the same event.
 */
@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

  constructor(
    @InjectModel(AuditLog.name)
    private readonly auditLogModel: Model<AuditLogDocument>,
  ) {}

  /**
   * Read-only lookup — added for the Banned Visitors screen (Settings →
   * Banned), which needs a real "Date created" per ban even though neither
   * `Visitor` nor `Site.bannedIps` carries a ban timestamp of its own (see
   * `VisitorsService.findBanned`'s doc comment). Every `ban()` call already
   * writes a `visitor.banned` entry here via `record()` above — this just
   * reads that back, most-recent first. Purely additive: does not touch
   * `record()` or any write path, and changes nothing about what gets
   * logged or when.
   */
  async findByAction(
    siteId: string,
    action: string,
  ): Promise<
    Array<{
      targetId?: Types.ObjectId;
      metadata?: Record<string, unknown>;
      createdAt: Date;
    }>
  > {
    return this.auditLogModel
      .find({ siteId: new Types.ObjectId(siteId), action })
      .select('targetId metadata createdAt')
      .sort({ createdAt: -1 })
      .lean()
      .exec();
  }

  async record(input: RecordAuditLogInput): Promise<void> {
    try {
      await this.auditLogModel.create({
        actorType: input.actorType,
        actorId: input.actorId,
        action: input.action,
        siteId: input.siteId,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata,
      });
      this.logger.log(
        JSON.stringify({
          event: input.action,
          actorType: input.actorType,
          actorId: input.actorId?.toString(),
          siteId: input.siteId?.toString(),
          targetType: input.targetType,
          targetId: input.targetId?.toString(),
        }),
      );
    } catch (err) {
      // Audit logging must never break the calling request.
      this.logger.error(
        `Failed to write audit log for action "${input.action}": ${(err as Error).message}`,
      );
    }
  }
}
