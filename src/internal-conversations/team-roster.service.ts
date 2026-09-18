import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  Conversation,
  ConversationDocument,
  Department,
  DepartmentDocument,
  User,
  UserDocument,
} from '../database/schemas';
import { PresenceService } from '../realtime/presence.service';
import { PermissionsService } from '../rbac/permissions.service';

export interface TeamRosterRow {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  /** 'online' | 'away' | 'offline' — same values as `PresenceService.getStatus`; a genuinely disconnected User (no live socket) always reports 'offline' here regardless of their last persisted `User.status`, matching the Team panel's "presence dot" requirement. */
  status: 'online' | 'away' | 'offline';
  isAdmin: boolean;
  activeChatCount: number;
  /** `User.chatLimit` — `null` means unlimited (rendered as "—" by the client, per SRS Feature 4's "—/3" convention; never treated as a limit of zero). */
  chatLimit: number | null;
  departmentId: string | null;
}

export interface TeamRosterDepartmentGroup {
  departmentId: string | null;
  departmentName: string | null;
  onlineCount: number;
  totalCount: number;
  members: TeamRosterRow[];
}

export interface TeamRoster {
  all: TeamRosterDepartmentGroup;
  departments: TeamRosterDepartmentGroup[];
  /** Members with no `departmentId` set — SRS Feature 4's "No department" accordion section. */
  noDepartment: TeamRosterDepartmentGroup;
}

/**
 * TeamRosterService — SRS Feature 4 ("Agents signed in" modal + the
 * sidebar's short online-colleagues list). Organization-wide (task
 * guardrail: every User can see every other User, no Site scoping) —
 * deliberately does NOT reuse `PermissionsService.getAuthorizedSites` or any
 * `conversations.view_*` check the way visitor-Conversation listing does;
 * membership here is "same Organization," full stop.
 *
 * Pulls together four pieces that already exist independently, per this
 * session's task ("Department/presence/admin/chat-count aggregation
 * helper"):
 *   - presence: `PresenceService.getStatus` (in-memory, live-connection
 *     source of truth — NOT `User.status`, which can lag by however long a
 *     disconnect takes to `persist()`; see that service's own doc comment)
 *   - admin: `PermissionsService.hasPermission(userId, 'roles.manage')`,
 *     org-wide (siteId omitted) — the mapping SRS Feature 4's design section
 *     specifies for the "Admin" checkmark column
 *   - chat-count: the EXACT SAME `Conversation.countDocuments({
 *     assignedAgentId, status: { $in: ['open', 'pending'] } })` shape
 *     `ConversationsService.pickAgentForRouting` already uses for routing
 *     eligibility — reused here as a read, not duplicated with different
 *     status semantics
 *   - Department: a flat `User.departmentId` (single Department per User,
 *     no isEnabled/membership-list concept beyond that FK today) grouped
 *     into the "All agents" / one-per-Department / "No department" shape
 *     the modal's accordion needs
 */
@Injectable()
export class TeamRosterService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Conversation.name)
    private readonly conversationModel: Model<ConversationDocument>,
    private readonly presenceService: PresenceService,
    private readonly permissionsService: PermissionsService,
  ) {}

  async getRoster(organizationId: Types.ObjectId): Promise<TeamRoster> {
    const users = await this.userModel
      .find({ organizationId, enabled: true })
      .select('_id displayName avatarUrl departmentId chatLimit')
      .lean()
      .exec();

    const departments = await this.departmentModel
      .find({
        _id: { $in: users.map((u) => u.departmentId).filter(Boolean) },
      })
      .select('_id name')
      .lean()
      .exec();
    const departmentNameById = new Map(
      departments.map((d) => [d._id.toString(), d.name]),
    );

    const activeCounts = await this.getActiveChatCounts(
      users.map((u) => u._id),
    );

    const rows: TeamRosterRow[] = await Promise.all(
      users.map(async (u) => {
        const userId = u._id.toString();
        return {
          userId,
          displayName: u.displayName,
          avatarUrl: u.avatarUrl ?? null,
          status: this.presenceService.getStatus(userId),
          isAdmin: await this.permissionsService.hasPermission(
            userId,
            'roles.manage',
            null,
          ),
          activeChatCount: activeCounts.get(userId) ?? 0,
          chatLimit: u.chatLimit ?? null,
          departmentId: u.departmentId?.toString() ?? null,
        };
      }),
    );

    const all = this.groupToSection(null, null, rows);
    const noDepartment = this.groupToSection(
      null,
      null,
      rows.filter((r) => r.departmentId === null),
    );
    const departmentGroups = [...departmentNameById.entries()]
      .map(([departmentId, departmentName]) =>
        this.groupToSection(
          departmentId,
          departmentName,
          rows.filter((r) => r.departmentId === departmentId),
        ),
      )
      .sort((a, b) =>
        (a.departmentName ?? '').localeCompare(b.departmentName ?? ''),
      );

    return { all, departments: departmentGroups, noDepartment };
  }

  /**
   * Same query shape as `ConversationsService.pickAgentForRouting`'s
   * per-agent count (see that method) — "active" means `status` in
   * `open`/`pending`, run once here as a single `$in`-batched query across
   * every roster member rather than N sequential `countDocuments` calls.
   */
  private async getActiveChatCounts(
    userIds: Types.ObjectId[],
  ): Promise<Map<string, number>> {
    if (userIds.length === 0) return new Map();
    const results = await this.conversationModel
      .aggregate<{ _id: Types.ObjectId; count: number }>([
        {
          $match: {
            assignedAgentId: { $in: userIds },
            status: { $in: ['open', 'pending'] },
          },
        },
        { $group: { _id: '$assignedAgentId', count: { $sum: 1 } } },
      ])
      .exec();
    return new Map(results.map((r) => [r._id.toString(), r.count]));
  }

  private groupToSection(
    departmentId: string | null,
    departmentName: string | null,
    members: TeamRosterRow[],
  ): TeamRosterDepartmentGroup {
    return {
      departmentId,
      departmentName,
      onlineCount: members.filter((m) => m.status === 'online').length,
      totalCount: members.length,
      members,
    };
  }
}
