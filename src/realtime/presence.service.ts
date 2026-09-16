import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { User, UserDocument } from '../database/schemas';
import { RealtimeEventsService } from './realtime-events.service';

export type PresenceStatus = 'online' | 'away' | 'offline';

interface PresenceEntry {
  status: PresenceStatus;
  socketIds: Set<string>;
}

/**
 * PresenceService — FR-AGT-02, §1.4/§6.2.
 *
 * In-memory Agent/Supervisor/Manager/Owner presence, held on this one
 * NestJS process (a plain `Map`) — Phase 1 explicitly has no Redis/shared
 * pub-sub (SRS §1.4: "kept in-memory within the single NestJS instance").
 * If/when the app ever runs more than one instance behind a load balancer,
 * this is the component that would need to move to a shared store; noted
 * as a Phase 2+ concern in the SRS, not solved here.
 *
 * Keyed by `userId` (a Visitor never has presence — visitors don't have an
 * "online/away/offline" concept, only Users do, per FR-AGT-02). A User can
 * have multiple open sockets (multiple browser tabs); status only flips to
 * `'offline'` once the LAST socket for that user disconnects. An explicit
 * `setStatus` call (the user manually toggling Online/Away/Offline) always
 * wins over the implicit connect/disconnect-derived default.
 *
 * Also persists the current status onto `User.status` (the field already
 * existed in the schema since Session 1, unused until now) so anything
 * reading a User document directly (e.g. Session 4's `GET /sites/:siteId/users`
 * list) reflects live presence too, not just WebSocket-connected clients.
 */
@Injectable()
export class PresenceService {
  private readonly logger = new Logger(PresenceService.name);
  private readonly presence = new Map<string, PresenceEntry>();

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<UserDocument>,
    private readonly realtimeEvents: RealtimeEventsService,
  ) {}

  /** Call once per WebSocket connection. Returns the status now in effect. */
  async addConnection(
    userId: string,
    socketId: string,
  ): Promise<PresenceStatus> {
    let entry = this.presence.get(userId);
    if (!entry) {
      entry = { status: 'online', socketIds: new Set() };
      this.presence.set(userId, entry);
      await this.persist(userId, 'online');
    }
    entry.socketIds.add(socketId);
    return entry.status;
  }

  /**
   * Call once per WebSocket disconnection. Returns the status now in effect,
   * or `null` if this user had no tracked presence at all (shouldn't happen
   * in practice, but defensive).
   */
  async removeConnection(
    userId: string,
    socketId: string,
  ): Promise<PresenceStatus | null> {
    const entry = this.presence.get(userId);
    if (!entry) return null;

    entry.socketIds.delete(socketId);
    if (entry.socketIds.size === 0) {
      this.presence.delete(userId);
      await this.persist(userId, 'offline');
      return 'offline';
    }
    return entry.status;
  }

  /** Explicit status change (FR-AGT-02's Online/Away/Offline toggle). */
  async setStatus(userId: string, status: PresenceStatus): Promise<void> {
    const entry = this.presence.get(userId);
    if (entry) {
      entry.status = status;
    } else if (status !== 'offline') {
      // No active socket tracked yet but an explicit non-offline status was
      // requested — keep the map structurally consistent so a socket that
      // connects moments later doesn't stomp it back to 'online'.
      this.presence.set(userId, { status, socketIds: new Set() });
    }
    await this.persist(userId, status);
  }

  /**
   * SRS §1.3 (Idle Timeout) — the automatic counterpart to `setStatus`
   * above, called by `RealtimeGateway`'s `agent:presence.idle` handler when
   * the FRONTEND's inactivity timer (Session Feature-1c-frontend) elapses.
   * Deliberately a SEPARATE method rather than a new `setStatus` branch: it
   * always clamps to `'away'` regardless of the caller's configured
   * `idleStatus` (`'invisible'` is storable on `User.idleTimeoutSettings`
   * per the SRS's literal shape — see that schema's doc comment — but
   * `PresenceStatus` has no `'invisible'` value yet, so an Agent who
   * configured `'invisible'` is auto-changed to `'away'` today; this
   * narrows, not silently drops, the setting: nothing errors, and the
   * stored `idleStatus: 'invisible'` preference is preserved for Feature 5
   * to honor once it lands), and it emits `presence.autoStatusChanged` so
   * SRS §1.2's "Status changes" desktop toggle / "Automatic status change"
   * sound can fire — a manual `setStatus` call never emits that event, by
   * design (guardrail: this is additive, the existing manual toggle's
   * behavior is unchanged).
   *
   * No-ops (returns without emitting) if the User is already `'away'` or
   * `'offline'` — nothing actually changed, so no "your status changed"
   * notification should fire. `ignoreIfChatting` is entirely the caller's
   * (frontend's) responsibility to evaluate before ever invoking this —
   * the server has no visibility into open floating chat windows.
   */
  async setIdleStatus(userId: string): Promise<PresenceStatus> {
    const previousStatus = this.getStatus(userId);
    if (previousStatus !== 'online') return previousStatus;

    await this.setStatus(userId, 'away');

    this.realtimeEvents.emit({
      kind: 'presence.autoStatusChanged',
      userId,
      status: 'away',
      previousStatus,
      timestamp: new Date().toISOString(),
    });

    return 'away';
  }

  getStatus(userId: string): PresenceStatus {
    return this.presence.get(userId)?.status ?? 'offline';
  }

  /** FR-RTE-01's "available (Online) Agent" check — used by auto-routing. */
  isOnline(userId: string): boolean {
    return this.getStatus(userId) === 'online';
  }

  private async persist(userId: string, status: PresenceStatus): Promise<void> {
    try {
      await this.userModel.findByIdAndUpdate(userId, { status }).exec();
    } catch (err) {
      // Presence is a best-effort UX signal, not a source of truth for
      // access control — never let a persistence hiccup break the socket
      // connection/disconnection flow it's called from.
      this.logger.warn(
        `Failed to persist presence status for user ${userId}: ${(err as Error).message}`,
      );
    }
  }
}
