import { NotFoundException } from '@nestjs/common';
import { Types } from 'mongoose';

import { SoundNotificationsService } from './sound-notifications.service';
import { SiteDocument, SoundNotificationSettings } from '../database/schemas';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';

/**
 * Verifies the two things worth a real test here: partial per-sound-key
 * merge (a naive `Object.assign(site.soundNotificationSettings, dto)`
 * would silently drop the other 5 events' fields — this is exactly the
 * "merge per sub-key, not the whole object" trap the plan flagged), and
 * organization-scoped 404 isolation. `assertSite`'s query itself is a
 * one-line Mongoose passthrough, not worth mocking beyond a fake
 * `findOne().exec()` chain.
 */
describe('SoundNotificationsService', () => {
  const organizationId = new Types.ObjectId();
  const actor = {
    userId: new Types.ObjectId().toString(),
    organizationId,
  } as unknown as AuthenticatedUser;

  function defaultSettings(): SoundNotificationSettings {
    return {
      incomingVisitor: { soundId: 'bright-ping', volume: 70 },
      chatRequest: { soundId: 'door-knock', volume: 70, repeatCount: 1 },
      incomingMessage: { soundId: 'dot-dot', volume: 70 },
      automaticStatusChange: { soundId: 'single-dong', volume: 70 },
      triggerActivated: { soundId: 'whistle-tone', volume: 70 },
      operatingHoursStartEnd: { soundId: 'flute-note', volume: 70 },
    } as SoundNotificationSettings;
  }

  function makeService(site: SiteDocument | null) {
    const save = jest.fn().mockResolvedValue(undefined);
    if (site) {
      (site as unknown as { save: typeof save }).save = save;
    }
    const siteModel = {
      findOne: jest.fn().mockReturnValue({
        exec: jest.fn().mockResolvedValue(site),
      }),
    };
    const auditLogService = { record: jest.fn().mockResolvedValue(undefined) };
    const service = new SoundNotificationsService(
      siteModel as never,
      auditLogService as never,
    );
    return { service, siteModel, auditLogService, save };
  }

  function makeSite(): SiteDocument {
    return {
      _id: new Types.ObjectId(),
      organizationId,
      soundNotificationSettings: defaultSettings(),
    } as unknown as SiteDocument;
  }

  it('get() returns the schema defaults for a site with no settings ever saved', async () => {
    const site = makeSite();
    const { service } = makeService(site);

    const result = await service.get(actor, site._id.toString());

    expect(result).toEqual(defaultSettings());
  });

  it('update() partial-merges one sound field without clobbering the other five', async () => {
    const site = makeSite();
    const { service, save } = makeService(site);

    const result = await service.update(actor, site._id.toString(), {
      incomingVisitor: { soundId: 'classic-uh-oh', volume: 100 },
    });

    expect(result.incomingVisitor).toEqual({
      soundId: 'classic-uh-oh',
      volume: 100,
    });
    expect(result.chatRequest).toEqual(defaultSettings().chatRequest);
    expect(result.incomingMessage).toEqual(defaultSettings().incomingMessage);
    expect(result.automaticStatusChange).toEqual(
      defaultSettings().automaticStatusChange,
    );
    expect(result.triggerActivated).toEqual(defaultSettings().triggerActivated);
    expect(result.operatingHoursStartEnd).toEqual(
      defaultSettings().operatingHoursStartEnd,
    );
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('update() partial-merges a nested chatRequest field (repeatCount only) without dropping soundId/volume', async () => {
    const site = makeSite();
    const { service } = makeService(site);

    const result = await service.update(actor, site._id.toString(), {
      chatRequest: { repeatCount: 5 },
    });

    expect(result.chatRequest).toEqual({
      soundId: 'door-knock',
      volume: 70,
      repeatCount: 5,
    });
  });

  it('get() 404s for a site in a different organization', async () => {
    const { service } = makeService(null);

    await expect(service.get(actor, new Types.ObjectId().toString())).rejects.toThrow(
      NotFoundException,
    );
  });
});
