import { Types } from 'mongoose';

import { InternalConversationsService } from './internal-conversations.service';
import { InternalConversationDocument } from '../database/schemas';

/**
 * Verifies the one thing worth a real test here: repeated find-or-create
 * calls for the same pair of Users never create a second
 * InternalConversation, regardless of argument order (SRS Feature 4 — "reused
 * (not duplicated) on subsequent clicks," same de-dup-by-existing-window
 * behavior as visitor conversations, FR-P2-WIN-03).
 */
describe('InternalConversationsService', () => {
  const organizationId = new Types.ObjectId();
  const userA = new Types.ObjectId();
  const userB = new Types.ObjectId();

  function makeService() {
    const store: InternalConversationDocument[] = [];

    const model = {
      findOneAndUpdate: jest.fn(
        (
          filter: {
            organizationId: Types.ObjectId;
            participantIds: Types.ObjectId[];
          },
          update: {
            $setOnInsert: Partial<InternalConversationDocument>;
          },
        ) => ({
          exec: jest.fn(() => {
            const [first, second] = filter.participantIds;
            const found = store.find(
              (doc) =>
                doc.organizationId.equals(filter.organizationId) &&
                doc.participantIds[0].equals(first) &&
                doc.participantIds[1].equals(second),
            );
            if (found) {
              return found;
            }
            const created = {
              _id: new Types.ObjectId(),
              ...update.$setOnInsert,
            } as InternalConversationDocument;
            store.push(created);
            return created;
          }),
        }),
      ),
      findOne: jest.fn(
        (filter: {
          organizationId: Types.ObjectId;
          participantIds: Types.ObjectId[];
        }) => ({
          exec: jest.fn(() => {
            const [first, second] = filter.participantIds;
            return (
              store.find(
                (doc) =>
                  doc.organizationId.equals(filter.organizationId) &&
                  doc.participantIds[0].equals(first) &&
                  doc.participantIds[1].equals(second),
              ) ?? null
            );
          }),
        }),
      ),
    };

    // Not exercised by these two find-or-create-only tests — an empty stub
    // is enough to satisfy the constructor now that sendMessage/markRead
    // (this session's additions) also need an InternalMessage model.
    const messageModel = {};
    const service = new InternalConversationsService(
      model as never,
      messageModel as never,
    );
    return { service, store };
  }

  it('find-or-create returns the same InternalConversation on repeated calls, no duplicates created', async () => {
    const { service, store } = makeService();

    const first = await service.findOrCreate(organizationId, userA, userB);
    const second = await service.findOrCreate(organizationId, userA, userB);

    expect(store).toHaveLength(1);
    expect(second._id).toEqual(first._id);
  });

  it('find-or-create is order-independent — reversing the two User ids still returns the existing pair', async () => {
    const { service, store } = makeService();

    const first = await service.findOrCreate(organizationId, userA, userB);
    const reversed = await service.findOrCreate(organizationId, userB, userA);

    expect(store).toHaveLength(1);
    expect(reversed._id).toEqual(first._id);
  });
});
