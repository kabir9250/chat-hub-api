import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';

import {
  InternalConversation,
  InternalConversationDocument,
  InternalMessage,
  InternalMessageDocument,
} from '../database/schemas';

const DUPLICATE_KEY_ERROR_CODE = 11000;

export interface InternalMessageWire {
  id: string;
  internalConversationId: string;
  senderId: string;
  body: string | null;
  attachments: [];
  sentAt: string;
  deliveredAt: string | null;
  readAt: string | null;
}

@Injectable()
export class InternalConversationsService {
  constructor(
    @InjectModel(InternalConversation.name)
    private readonly internalConversationModel: Model<InternalConversationDocument>,
    @InjectModel(InternalMessage.name)
    private readonly internalMessageModel: Model<InternalMessageDocument>,
  ) {}

  /**
   * Returns the 1:1 InternalConversation between these two Users, creating
   * it lazily on first contact — same de-dup-by-existing-window behavior as
   * visitor conversations (Phase 2 FR-P2-WIN-03: reuse, don't duplicate, on
   * a repeated "open chat" click). `participantIds` is always stored sorted
   * so the pair is order-independent, matching the schema's unique compound
   * index on `(organizationId, participantIds.0, participantIds.1)` — an
   * upsert via that index is what makes this safe under two concurrent
   * "open chat" clicks racing each other, not just repeated sequential
   * calls.
   */
  async findOrCreate(
    organizationId: Types.ObjectId,
    userIdA: Types.ObjectId,
    userIdB: Types.ObjectId,
  ): Promise<InternalConversationDocument> {
    const [first, second] = [userIdA, userIdB].sort((a, b) =>
      a.toString().localeCompare(b.toString()),
    );

    try {
      return await this.internalConversationModel
        .findOneAndUpdate(
          { organizationId, participantIds: [first, second] },
          {
            $setOnInsert: {
              organizationId,
              participantIds: [first, second],
              createdAt: new Date(),
              lastMessageAt: null,
            },
          },
          { upsert: true, new: true },
        )
        .exec();
    } catch (err) {
      // Lost the insert race to a concurrent call — the winner's row is now
      // there, so just read it back instead of failing.
      if ((err as { code?: number }).code === DUPLICATE_KEY_ERROR_CODE) {
        const existing = await this.internalConversationModel
          .findOne({ organizationId, participantIds: [first, second] })
          .exec();
        if (existing) {
          return existing;
        }
      }
      throw err;
    }
  }

  /**
   * Persists a new InternalMessage and bumps the parent InternalConversation's
   * denormalized `lastMessageAt` (same reasoning as that field's own doc
   * comment — keeps sidebar recency sort cheap). `senderId` must be one of
   * the conversation's two `participantIds` — callers (the gateway) already
   * only reach this after `findOrCreate`/an existing-conversation lookup
   * scoped to the caller's own userId, but this is re-checked here too
   * rather than trusted blindly, same "service re-verifies, doesn't just
   * trust the caller" posture `ConversationsService`'s own send-message
   * methods use.
   */
  async sendMessage(
    conversation: InternalConversationDocument,
    senderId: Types.ObjectId,
    body: string | null,
  ): Promise<InternalMessageDocument> {
    if (!conversation.participantIds.some((id) => id.equals(senderId))) {
      throw new BadRequestException(
        'senderId is not a participant of this internal conversation.',
      );
    }
    if (!body?.trim()) {
      throw new BadRequestException('A message must include text.');
    }

    const message = await this.internalMessageModel.create({
      internalConversationId: conversation._id,
      senderId,
      body: body.trim(),
      attachments: [],
      sentAt: new Date(),
      deliveredAt: null,
      readAt: null,
    });

    conversation.lastMessageAt = message.sentAt;
    await conversation.save();

    return message;
  }

  /** Find-or-404 by id, scoped to the caller's own organization+participation — the same "prove you belong here" check every read/write below needs before touching a specific conversation. */
  async findByIdForParticipant(
    organizationId: Types.ObjectId,
    conversationId: string,
    userId: Types.ObjectId,
  ): Promise<InternalConversationDocument | null> {
    if (!Types.ObjectId.isValid(conversationId)) return null;
    return this.internalConversationModel
      .findOne({
        _id: conversationId,
        organizationId,
        participantIds: userId,
      })
      .exec();
  }

  /**
   * Symmetric read receipts (SRS Feature 4 — "no visitor-side asymmetry,"
   * unlike `ConversationsService.deliverPendingMessages`/
   * `markDeliveredMessagesRead`'s Agent/Visitor split): the RECIPIENT
   * (never the sender) calls this against messages the OTHER participant
   * sent, advancing `deliveredAt` for anything still `null` and `readAt`
   * for anything still unread. Returns the updated messages so the caller
   * can broadcast one `internalMessage.updated` event per message —
   * mirrors `markDeliveredMessagesRead`'s "batch the DB write, still emit
   * one tick-update per message" shape.
   */
  async markRead(
    conversation: InternalConversationDocument,
    readerId: Types.ObjectId,
  ): Promise<InternalMessageDocument[]> {
    const now = new Date();
    const unread = await this.internalMessageModel
      .find({
        internalConversationId: conversation._id,
        senderId: { $ne: readerId },
        readAt: null,
      })
      .exec();
    if (unread.length === 0) return [];

    await this.internalMessageModel
      .updateMany({ _id: { $in: unread.map((m) => m._id) } }, [
        {
          $set: {
            deliveredAt: { $ifNull: ['$deliveredAt', now] },
            readAt: now,
          },
        },
      ])
      .exec();

    for (const m of unread) {
      m.deliveredAt = m.deliveredAt ?? now;
      m.readAt = now;
    }
    return unread;
  }

  async listMessages(
    conversationId: Types.ObjectId,
  ): Promise<InternalMessageDocument[]> {
    return this.internalMessageModel
      .find({ internalConversationId: conversationId })
      .sort({ sentAt: 1 })
      .exec();
  }

  toWire(message: InternalMessageDocument): InternalMessageWire {
    return {
      id: message._id.toString(),
      internalConversationId: message.internalConversationId.toString(),
      senderId: message.senderId.toString(),
      body: message.body,
      attachments: [],
      sentAt: message.sentAt.toISOString(),
      deliveredAt: message.deliveredAt?.toISOString() ?? null,
      readAt: message.readAt?.toISOString() ?? null,
    };
  }
}
