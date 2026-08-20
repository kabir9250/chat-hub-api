import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';

import { Counter, CounterDocument } from '../database/schemas';

const CONVERSATION_COUNTER_ID = 'conversationReferenceNumber';
// Starting offset so the very first reference number already reads as an
// 8-digit ticket ("#10000001"), matching the SRS's own "#12345678" example,
// rather than starting at "#00000001".
const REFERENCE_NUMBER_OFFSET = 10_000_000;

/**
 * FR-CONV-01: "Every conversation shall have a unique, human-readable
 * reference number." Backed by an atomic `findOneAndUpdate($inc, upsert)`
 * against the `counters` collection (see counter.schema.ts) — safe under
 * concurrent conversation creation (unlike `Conversation.countDocuments() + 1`,
 * which races). Uniqueness is additionally enforced by the schema's own
 * `unique: true` index on `Conversation.referenceNumber` as a second line
 * of defense.
 */
@Injectable()
export class ReferenceNumberService {
  constructor(
    @InjectModel(Counter.name)
    private readonly counterModel: Model<CounterDocument>,
  ) {}

  async next(): Promise<string> {
    const counter = await this.counterModel
      .findOneAndUpdate(
        { _id: CONVERSATION_COUNTER_ID },
        { $inc: { seq: 1 } },
        { upsert: true, new: true },
      )
      .exec();

    return `#${(REFERENCE_NUMBER_OFFSET + counter.seq).toString()}`;
  }
}
