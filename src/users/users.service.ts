import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { FilterQuery, Model, Types } from 'mongoose';
import * as bcrypt from 'bcryptjs';

import { User, UserDocument } from '../database/schemas/user.schema';
import { Role, RoleDocument } from '../database/schemas/role.schema';
import {
  Department,
  DepartmentDocument,
} from '../database/schemas/department.schema';
import { Site, SiteDocument } from '../database/schemas/site.schema';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { PermissionsService } from '../rbac/permissions.service';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateNotificationPreferencesDto } from './dto/update-notification-preferences.dto';
import { UpdateIdleTimeoutSettingsDto } from './dto/update-idle-timeout-settings.dto';
import type { IdleTimeoutSettings } from '../database/schemas/user.schema';
import { UpdateMyProfileDto } from './dto/update-my-profile.dto';
import { UpdateMyAccountDto } from './dto/update-my-account.dto';
import {
  ChatRequestSoundSetting,
  NotificationPreferences,
} from '../database/schemas/user.schema';
import { StorageService } from '../storage/storage.service';
import { validateAvatarFile } from '../storage/attachment-validation';

// See UsersService.uploadAvatar's doc comment for why this isn't the
// default chat-attachment TTL.
const AVATAR_SIGNED_URL_TTL_SECONDS = 365 * 24 * 60 * 60; // 1 year

export interface UserListResult {
  items: UserDocument[];
  counts: { total: number; enabled: number };
  /** FR-USR-05's literal "3 enabled / 3 agents" format, pre-formatted for convenience. */
  summary: string;
}

/**
 * UsersService — FR-USR-01/02/03/05/06.
 *
 * `PermissionGuard` (via `users.manage`/`users.view`, checked against the
 * route's `:siteId`) already decides WHETHER the caller can reach these
 * endpoints for that Site. This service additionally enforces:
 *   - a created User always gets an initial Role Assignment (FR-USR-03 —
 *     no User may exist with zero access);
 *   - edit/enable-disable/delete only ever touch a User who actually has
 *     access to the target Site (an Organization-scoped Role Assignment,
 *     or a Site-scoped one for this Site) — so a Site-scoped `users.manage`
 *     holder can't (accidentally or otherwise) reach into an unrelated
 *     User who merely shares the Organization;
 *   - granting an ORGANIZATION-scoped Role Assignment on create requires
 *     the actor to hold `users.manage` Organization-wide themselves — a
 *     Site-scoped Supervisor cannot use "create a user" as a side door to
 *     grant org-wide access they don't have (mirrors the FR-RBAC-09(a)
 *     escalation guard's spirit from Session 3's Roles/RoleAssignments).
 */
@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    @InjectModel(Role.name) private readonly roleModel: Model<RoleDocument>,
    @InjectModel(Department.name)
    private readonly departmentModel: Model<DepartmentDocument>,
    @InjectModel(Site.name) private readonly siteModel: Model<SiteDocument>,
    private readonly permissionsService: PermissionsService,
    private readonly auditLogService: AuditLogService,
    private readonly storage: StorageService,
  ) {}

  async findAll(
    actor: AuthenticatedUser,
    siteId: string,
    departmentId?: string,
  ): Promise<UserListResult> {
    const site = await this.assertSite(actor, siteId);

    const filter: FilterQuery<UserDocument> = {
      organizationId: actor.organizationId,
      $or: [
        { roleAssignments: { $elemMatch: { scopeType: 'ORGANIZATION' } } },
        {
          roleAssignments: {
            $elemMatch: { scopeType: 'SITE', siteId: site._id },
          },
        },
      ],
    };

    if (departmentId) {
      const department = await this.departmentModel
        .findOne({ _id: departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      filter.departmentId = department._id;
    }

    const items = await this.userModel
      .find(filter)
      .sort({ displayName: 1 })
      .exec();
    const total = items.length;
    const enabled = items.filter((u) => u.enabled).length;

    return {
      items,
      counts: { total, enabled },
      summary: `${enabled} enabled / ${total} agents`,
    };
  }

  async create(
    actor: AuthenticatedUser,
    siteId: string,
    dto: CreateUserDto,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);

    const role = await this.roleModel
      .findOne({
        _id: dto.initialRoleAssignment.roleId,
        organizationId: actor.organizationId,
      })
      .exec();
    if (!role) {
      throw new NotFoundException('Role not found in this Organization.');
    }

    if (dto.initialRoleAssignment.scopeType === 'ORGANIZATION') {
      const actorHasOrgWide = await this.permissionsService.hasPermission(
        actor.userId,
        'users.manage',
        null,
      );
      if (!actorHasOrgWide) {
        throw new ForbiddenException(
          'Only a User holding users.manage Organization-wide can grant an Organization-scoped Role Assignment.',
        );
      }
    }

    let departmentId: Types.ObjectId | undefined;
    if (dto.departmentId) {
      const department = await this.departmentModel
        .findOne({ _id: dto.departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      departmentId = department._id;
    }

    let user: UserDocument;
    try {
      user = await this.userModel.create({
        organizationId: actor.organizationId,
        displayName: dto.displayName.trim(),
        fullName: dto.fullName.trim(),
        email: dto.email.trim().toLowerCase(),
        supportEmail: dto.supportEmail?.trim().toLowerCase(),
        // Hardening session: bumped bcrypt cost 10 -> 12 (OWASP's current
        // recommended floor is 10; 12 costs a few hundred extra ms per
        // login/create on bcryptjs's pure-JS implementation, negligible at
        // this app's scale). Existing hashes at cost 10 remain valid —
        // bcrypt encodes its own cost in the hash, `bcrypt.compare` reads it
        // back out, so no migration is needed for already-seeded accounts.
        passwordHash: bcrypt.hashSync(dto.password, 12),
        departmentId: departmentId ?? null,
        enabled: dto.enabled ?? true,
        roleAssignments: [
          {
            roleId: role._id,
            scopeType: dto.initialRoleAssignment.scopeType,
            siteId:
              dto.initialRoleAssignment.scopeType === 'SITE'
                ? site._id
                : undefined,
            createdByUserId: new Types.ObjectId(actor.userId),
          },
        ],
      });
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw err;
    }

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.created',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: {
        email: user.email,
        roleId: role._id.toString(),
        roleName: role.name,
        scopeType: dto.initialRoleAssignment.scopeType,
        departmentId: departmentId?.toString(),
      },
    });

    return user;
  }

  async update(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
    dto: UpdateUserDto,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    const before = {
      displayName: user.displayName,
      fullName: user.fullName,
      email: user.email,
      supportEmail: user.supportEmail,
      departmentId: user.departmentId?.toString() ?? null,
    };

    if (dto.displayName !== undefined)
      user.displayName = dto.displayName.trim();
    if (dto.fullName !== undefined) user.fullName = dto.fullName.trim();
    if (dto.email !== undefined) user.email = dto.email.trim().toLowerCase();
    if (dto.supportEmail !== undefined)
      user.supportEmail = dto.supportEmail.trim().toLowerCase();
    if (dto.departmentId !== undefined) {
      const department = await this.departmentModel
        .findOne({ _id: dto.departmentId, siteId: site._id })
        .exec();
      if (!department) {
        throw new BadRequestException('Department not found on this Site.');
      }
      user.departmentId = department._id;
    }

    try {
      await user.save();
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw err;
    }

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.updated',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: {
        before,
        after: {
          displayName: user.displayName,
          fullName: user.fullName,
          email: user.email,
          supportEmail: user.supportEmail,
          departmentId: user.departmentId?.toString() ?? null,
        },
      },
    });

    return user;
  }

  /**
   * Phase 2, SRS §2.1 / §3.8 FR-P2-NOTIF-05, restructured this session (SRS
   * "12-zendesk-feature-parity" §1.2) for per-event granularity — `PATCH
   * /users/me/notification-preferences`. Deliberately NOT routed through
   * `assertSite`/`findUserOnSite` (no `:siteId` in this route at all — see
   * `MeController`) and gated by nothing but `JwtAuthGuard`: this only ever
   * touches the CALLER's own document (`actor.userId`, never a `:userId`
   * route param), so there is no cross-User/cross-Site boundary for
   * `PermissionGuard` to enforce here, matching the SRS's explicit "no
   * special permission needed" / "self-service" wording. Not audit-logged,
   * same precedent as `PresenceService.setPresence` — a personal UI
   * preference, not an access-control or Visitor-facing change.
   *
   * Every level is independently patchable, same contract the old flat DTO
   * had: `dto.sounds.chatRequest.volume` alone updates just that one number
   * without touching `dto.sounds.chatRequest.soundId`/`.repeatCount` or any
   * other event's settings.
   */
  async updateNotificationPreferences(
    actor: AuthenticatedUser,
    dto: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferences> {
    const user = await this.userModel.findById(actor.userId).exec();
    if (!user) {
      // Can't actually happen behind JwtAuthGuard (it already re-loads and
      // 401s on a missing User on every request) — kept for type-safety/
      // defense in depth, same shape every other lookup in this file uses.
      throw new NotFoundException('User not found.');
    }

    const prefs = user.notificationPreferences;
    if (dto.chatRequest !== undefined) prefs.chatRequest = dto.chatRequest;
    if (dto.newMessages !== undefined) prefs.newMessages = dto.newMessages;
    if (dto.statusChanges !== undefined) {
      prefs.statusChanges = dto.statusChanges;
    }
    if (dto.sessionExpiry !== undefined) {
      prefs.sessionExpiry = dto.sessionExpiry;
    }

    if (dto.sounds) {
      const soundEvents = [
        'incomingVisitor',
        'chatRequest',
        'incomingMessage',
        'automaticStatusChange',
        'triggerActivated',
        'operatingHoursStartEnd',
      ] as const;
      for (const key of soundEvents) {
        const patch = dto.sounds[key];
        if (!patch) continue;
        const setting = prefs.sounds[key];
        if (patch.soundId !== undefined) setting.soundId = patch.soundId;
        if (patch.volume !== undefined) setting.volume = patch.volume;
        if (
          key === 'chatRequest' &&
          'repeatCount' in patch &&
          patch.repeatCount !== undefined
        ) {
          (setting as ChatRequestSoundSetting).repeatCount = patch.repeatCount;
        }
      }
    }

    await user.save();

    return user.notificationPreferences;
  }

  /**
   * Session Feature-1c-backend, SRS "12-zendesk-feature-parity" §1.3 —
   * `PATCH /users/me/idle-timeout-settings`. Same self-service shape as
   * `updateNotificationPreferences` above (no PermissionGuard, only ever
   * touches `actor.userId`, not audit-logged — a personal UX preference).
   * Every field independently patchable.
   */
  async updateIdleTimeoutSettings(
    actor: AuthenticatedUser,
    dto: UpdateIdleTimeoutSettingsDto,
  ): Promise<IdleTimeoutSettings> {
    const user = await this.userModel.findById(actor.userId).exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const settings = user.idleTimeoutSettings;
    if (dto.enabled !== undefined) settings.enabled = dto.enabled;
    if (dto.ignoreIfChatting !== undefined) {
      settings.ignoreIfChatting = dto.ignoreIfChatting;
    }
    if (dto.inactivityMinutes !== undefined) {
      settings.inactivityMinutes = dto.inactivityMinutes;
    }
    if (dto.idleStatus !== undefined) settings.idleStatus = dto.idleStatus;

    await user.save();

    return user.idleTimeoutSettings;
  }

  /**
   * Personal Settings → Profile (this session, SRS "12-zendesk-feature-
   * parity" §1.1) — `PATCH /users/me/profile`. Same "no PermissionGuard,
   * only ever touches actor.userId" shape as `updateNotificationPreferences`
   * above — see that method's doc comment. Never touches
   * email/passwordHash/roleAssignments — those are `updateAccount`'s (email/
   * password) or simply off-limits (roleAssignments — task guardrail: this
   * flow can never self-escalate permissions).
   */
  async updateProfile(
    actor: AuthenticatedUser,
    dto: UpdateMyProfileDto,
  ): Promise<UserDocument> {
    const user = await this.userModel.findById(actor.userId).exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (dto.displayName !== undefined)
      user.displayName = dto.displayName.trim();
    if (dto.tagline !== undefined) user.tagline = dto.tagline.trim();
    if (dto.preferredLanguage !== undefined)
      user.preferredLanguage = dto.preferredLanguage.trim();
    // Explicit `null` clears the limit ("Chat limit is not enabled");
    // `undefined` (key omitted from the request body) leaves it untouched —
    // class-validator's `@IsOptional()` lets `null` reach here unvalidated,
    // so this is the one place that distinction is actually applied.
    if (dto.chatLimit !== undefined) user.chatLimit = dto.chatLimit;
    if (dto.skills !== undefined) user.skills = dto.skills;
    if (dto.keyboardShortcutsEnabled !== undefined)
      user.keyboardShortcutsEnabled = dto.keyboardShortcutsEnabled;

    await user.save();
    return user;
  }

  /**
   * Personal Settings → Profile → "Edit profile" — `PATCH /users/me/account`.
   * Identity/security fields only (displayName/email/password); see
   * `UpdateMyAccountDto`'s doc comment for why this is a separate endpoint
   * from `updateProfile`. A password change requires `currentPassword` to
   * match the account's existing hash first (task requirement) — checked
   * here, not in the DTO, since it's a cross-field/DB-dependent rule.
   *
   * Returns a plain `{ displayName, email }` object, deliberately NOT the
   * `UserDocument` itself (unlike every other method in this file) — this
   * is the one place that queries with `.select('+passwordHash')` to run
   * the `bcrypt.compare` above, and Mongoose's default `toJSON` does NOT
   * strip an explicitly `+selected` field back out. Returning `user`
   * directly here would serialize `passwordHash` (old OR newly-set) straight
   * into the HTTP response body. Found live while verifying this session —
   * confirm this stays a plain object if this method is ever touched again.
   */
  async updateAccount(
    actor: AuthenticatedUser,
    dto: UpdateMyAccountDto,
  ): Promise<{ displayName: string; email: string }> {
    const user = await this.userModel
      .findById(actor.userId)
      .select('+passwordHash')
      .exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    if (dto.newPassword !== undefined) {
      if (!dto.currentPassword) {
        throw new BadRequestException(
          'currentPassword is required to change your password.',
        );
      }
      const matches = await bcrypt.compare(
        dto.currentPassword,
        user.passwordHash,
      );
      if (!matches) {
        throw new BadRequestException('Current password is incorrect.');
      }
      user.passwordHash = bcrypt.hashSync(dto.newPassword, 12);
    }

    if (dto.displayName !== undefined)
      user.displayName = dto.displayName.trim();
    if (dto.email !== undefined) user.email = dto.email.trim().toLowerCase();

    try {
      await user.save();
    } catch (err: unknown) {
      if (this.isDuplicateKeyError(err)) {
        throw new ConflictException('A user with this email already exists.');
      }
      throw err;
    }

    return { displayName: user.displayName, email: user.email };
  }

  /**
   * Personal Settings → Profile avatar upload — reuses the exact same
   * `StorageService` the chat-attachment upload path uses (task requirement:
   * "reuse the existing attachment-storage mechanism ... rather than
   * building a new upload path"), just under an `avatars/<userId>/` key
   * namespace instead of `<siteId>/<conversationId>/` — `StorageService`
   * doesn't actually care what those two path segments mean, it just needs
   * two strings to namespace the key. `getSignedUrl` (the same short-lived
   * HMAC-signed link every chat attachment uses) becomes `User.avatarUrl` —
   * this app never stores a permanent public URL for user-uploaded content.
   *
   * Uses a 1-year TTL override (`AVATAR_SIGNED_URL_TTL_SECONDS` below), not
   * the default 300s chat-attachment TTL: unlike a message attachment (whose
   * URL is re-minted fresh on every read via `ConversationsService`), an
   * avatar's URL is PERSISTED on `User.avatarUrl` and displayed all over the
   * console (top bar, account menu) — a 5-minute-lived link stored there
   * would silently start 403ing a few minutes after every upload. Re-
   * uploading (or removing/re-adding) naturally mints a fresh one.
   */
  async uploadAvatar(
    actor: AuthenticatedUser,
    file?: Express.Multer.File,
  ): Promise<UserDocument> {
    validateAvatarFile(file);
    const f = file!;

    const user = await this.userModel.findById(actor.userId).exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }

    const { key } = await this.storage.saveFile({
      siteId: 'avatars',
      conversationId: actor.userId,
      buffer: f.buffer,
      originalFileName: f.originalname,
      mimeType: f.mimetype,
    });
    user.avatarUrl = this.storage.getSignedUrl(
      { key, fileName: f.originalname, fileType: f.mimetype },
      AVATAR_SIGNED_URL_TTL_SECONDS,
    );
    await user.save();
    return user;
  }

  async removeAvatar(actor: AuthenticatedUser): Promise<UserDocument> {
    const user = await this.userModel.findById(actor.userId).exec();
    if (!user) {
      throw new NotFoundException('User not found.');
    }
    user.avatarUrl = undefined;
    await user.save();
    return user;
  }

  async setEnabled(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
    enabled: boolean,
  ): Promise<UserDocument> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    user.enabled = enabled;
    await user.save();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: enabled ? 'user.enabled' : 'user.disabled',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
    });

    return user;
  }

  async remove(
    actor: AuthenticatedUser,
    siteId: string,
    userId: string,
  ): Promise<void> {
    const site = await this.assertSite(actor, siteId);
    const user = await this.findUserOnSite(actor, site, userId);

    await user.deleteOne();

    await this.auditLogService.record({
      actorType: 'user',
      actorId: actor.userId,
      action: 'user.deleted',
      siteId: site._id,
      targetType: 'User',
      targetId: user._id,
      metadata: { email: user.email },
    });
  }

  private async assertSite(
    actor: AuthenticatedUser,
    siteId: string,
  ): Promise<SiteDocument> {
    const site = await this.siteModel
      .findOne({ _id: siteId, organizationId: actor.organizationId })
      .exec();
    if (!site) {
      throw new NotFoundException('Site not found in this Organization.');
    }
    return site;
  }

  /**
   * Fetches `userId` and confirms they actually have access to `site` (an
   * ORGANIZATION-scoped assignment, or a SITE-scoped one for this Site) —
   * the same boundary `PermissionsService` uses to compute effective
   * permissions. Without this, a Site-scoped `users.manage` holder could
   * edit/disable/delete any User in the Organization just by knowing their
   * id, regardless of Site.
   */
  private async findUserOnSite(
    actor: AuthenticatedUser,
    site: SiteDocument,
    userId: string,
  ): Promise<UserDocument> {
    const user = await this.userModel
      .findOne({ _id: userId, organizationId: actor.organizationId })
      .exec();
    if (!user || !this.userBelongsToSite(user, site._id.toString())) {
      throw new NotFoundException('User not found on this Site.');
    }
    return user;
  }

  private userBelongsToSite(user: UserDocument, siteId: string): boolean {
    return (user.roleAssignments ?? []).some(
      (a) =>
        a.scopeType === 'ORGANIZATION' ||
        (a.scopeType === 'SITE' && a.siteId?.toString() === siteId),
    );
  }

  private isDuplicateKeyError(err: unknown): boolean {
    return (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code?: number }).code === 11000
    );
  }
}
