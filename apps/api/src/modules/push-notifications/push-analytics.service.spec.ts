import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { PushAnalyticsService } from './push-analytics.service';
import { PushNotificationEventEntity } from './entities/push-notification-event.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { IdentityService } from '../identity/identity.service';
import { TouchpointsService } from '../touchpoints/touchpoints.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

/**
 * Chainable stand-in for a TypeORM query builder. `execute` and `getRawMany`
 * are the only terminals used here, so tests set those directly.
 */
function makeQueryBuilder() {
  const qb: any = {};
  for (const method of [
    'insert',
    'into',
    'values',
    'orIgnore',
    'select',
    'addSelect',
    'where',
    'groupBy',
    'addGroupBy',
  ]) {
    qb[method] = jest.fn(() => qb);
  }
  qb.execute = jest.fn();
  qb.getRawMany = jest.fn();
  return qb;
}

describe('PushAnalyticsService', () => {
  let service: PushAnalyticsService;
  let qb: ReturnType<typeof makeQueryBuilder>;

  const eventRepo = { createQueryBuilder: jest.fn() };
  const logRepo = { findOne: jest.fn(), find: jest.fn() };
  const identityService = { findByFingerprintAndProject: jest.fn() };
  const touchpointsService = { record: jest.fn() };

  const baseDto = {
    projectId: 'proj-1',
    campaignId: 'camp-1',
    deviceFingerprint: 'device-abc',
    type: 'click' as const,
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    qb = makeQueryBuilder();
    eventRepo.createQueryBuilder.mockReturnValue(qb);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: TrackingConsentService, useValue: trackingConsent },
        PushAnalyticsService,
        {
          provide: getRepositoryToken(PushNotificationEventEntity),
          useValue: eventRepo,
        },
        {
          provide: getRepositoryToken(PushNotificationLogEntity),
          useValue: logRepo,
        },
        { provide: IdentityService, useValue: identityService },
        { provide: TouchpointsService, useValue: touchpointsService },
      ],
    }).compile();

    service = module.get(PushAnalyticsService);
  });

  describe('recordEvent', () => {
    it('refuses a campaign that does not belong to the project', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.recordEvent(baseDto)).rejects.toThrow(
        NotFoundException,
      );

      // The lookup is project-scoped, so an API key cannot attach engagement
      // to another tenant's campaign by guessing its id.
      expect(logRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'camp-1', projectId: 'proj-1' },
      });
      expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('refuses a device that never identified', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce(null);

      await expect(service.recordEvent(baseDto)).rejects.toThrow(
        /Device identity not found/,
      );
      expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('records the event against the resolved device identity', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'ident-9',
      });
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });

      await expect(service.recordEvent(baseDto)).resolves.toEqual({
        recorded: true,
      });

      expect(qb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          campaignId: 'camp-1',
          deviceIdentityId: 'ident-9',
          type: 'click',
        }),
      );
    });

    it('absorbs a replayed event instead of double-counting it', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'ident-9',
      });
      // ON CONFLICT DO NOTHING returns no identifier when the row already existed.
      qb.execute.mockResolvedValueOnce({ identifiers: [undefined] });

      await expect(service.recordEvent(baseDto)).resolves.toEqual({
        recorded: false,
      });

      // Without orIgnore, a client retry or an OS re-delivery would inflate
      // the click count and with it every rate derived from it.
      expect(qb.orIgnore).toHaveBeenCalled();
    });

    it('trusts the device clock for when it happened', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'ident-9',
      });
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });

      await service.recordEvent({
        ...baseDto,
        occurredAt: '2026-09-06T10:00:00.000Z',
      });

      // A click made offline is only reported once connectivity returns, so
      // server receipt time would place it in the wrong hour.
      expect(qb.values).toHaveBeenCalledWith(
        expect.objectContaining({
          occurredAt: new Date('2026-09-06T10:00:00.000Z'),
        }),
      );
    });
  });

  describe('attribution', () => {
    const arrangeClick = () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1', title: 'Flash sale' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'ident-9',
      });
    };

    it('records a push_click touchpoint so push appears in attribution', async () => {
      arrangeClick();
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });

      await service.recordEvent({ ...baseDto, platform: 'android' });

      // push_click has always been a valid touchpoint type mapped to the push
      // channel, but only the seed script ever produced one — so push was
      // missing from every attribution report despite being a real channel.
      expect(touchpointsService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          deviceFingerprint: 'device-abc',
          touchpointType: 'push_click',
          campaign: 'Flash sale',
          metadata: { campaignId: 'camp-1' },
        }),
      );
    });

    it('keeps the click receipt but records no touchpoint for a do-not-track person', async () => {
      arrangeClick();
      trackingConsent.isDoNotTrack.mockResolvedValueOnce(true);
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });

      const result = await service.recordEvent({ ...baseDto, platform: 'android' });

      // The campaign's own report still counts the click...
      expect(result).toEqual({ recorded: true });
      expect(qb.execute).toHaveBeenCalledTimes(1);
      // ...but it is not credited to the person in attribution.
      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceIdentityId: 'ident-9',
      });
      expect(touchpointsService.record).not.toHaveBeenCalled();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('touchpoint');
    });

    it('does not add a second touchpoint for a replayed click', async () => {
      arrangeClick();
      qb.execute.mockResolvedValueOnce({ identifiers: [undefined] });

      await service.recordEvent(baseDto);

      // Otherwise a device retrying its report would over-credit push for the
      // conversion that follows.
      expect(touchpointsService.record).not.toHaveBeenCalled();
    });

    it('does not record a touchpoint for a delivery', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1', title: 'Flash sale' });
      identityService.findByFingerprintAndProject.mockResolvedValueOnce({
        id: 'ident-9',
      });
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });

      await service.recordEvent({ ...baseDto, type: 'delivered' });

      // Arriving on a handset is not an interaction and must not earn
      // attribution credit.
      expect(touchpointsService.record).not.toHaveBeenCalled();
    });

    it('still records the click when the touchpoint write fails', async () => {
      arrangeClick();
      qb.execute.mockResolvedValueOnce({ identifiers: [{ id: 'evt-1' }] });
      touchpointsService.record.mockRejectedValueOnce(new Error('db down'));

      // Attribution is a derived view; losing a touchpoint is a smaller harm
      // than rejecting the engagement event itself.
      await expect(service.recordEvent(baseDto)).resolves.toEqual({
        recorded: true,
      });
    });
  });

  describe('getEngagementFor', () => {
    it('queries nothing for an empty campaign list', async () => {
      await expect(service.getEngagementFor([])).resolves.toEqual(new Map());
      expect(eventRepo.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('rolls counts up by type and derives the click-through rate', async () => {
      qb.getRawMany.mockResolvedValueOnce([
        { campaignId: 'c1', type: 'delivered', count: '200' },
        { campaignId: 'c1', type: 'click', count: '50' },
        { campaignId: 'c1', type: 'impression', count: '120' },
      ]);

      const result = await service.getEngagementFor(['c1']);

      expect(result.get('c1')).toEqual({
        campaignId: 'c1',
        delivered: 200,
        impressions: 120,
        clicks: 50,
        dismissed: 0,
        bounced: 0,
        complained: 0,
        clickThroughRate: 25,
      });
    });

    it('counts email bounces and complaints reported by the provider', async () => {
      qb.getRawMany.mockResolvedValueOnce([
        { campaignId: 'c1', type: 'delivered', count: '90' },
        { campaignId: 'c1', type: 'bounced', count: '7' },
        { campaignId: 'c1', type: 'complained', count: '2' },
      ]);

      const result = await service.getEngagementFor(['c1']);

      expect(result.get('c1')).toMatchObject({ delivered: 90, bounced: 7, complained: 2 });
    });

    it('reports an unmeasured campaign as null CTR, not zero', async () => {
      qb.getRawMany.mockResolvedValueOnce([]);

      const result = await service.getEngagementFor(['c1']);

      // 0% says the campaign failed; null says nothing has reported yet. A
      // campaign whose SDK is not wired up must not look like a flop.
      expect(result.get('c1')?.clickThroughRate).toBeNull();
      expect(result.get('c1')?.delivered).toBe(0);
    });

    it('returns an entry for every campaign asked about', async () => {
      qb.getRawMany.mockResolvedValueOnce([
        { campaignId: 'c2', type: 'delivered', count: '10' },
      ]);

      const result = await service.getEngagementFor(['c1', 'c2', 'c3']);

      // The list renders a row per campaign; a missing key would render as
      // undefined rather than as "no data".
      expect([...result.keys()].sort()).toEqual(['c1', 'c2', 'c3']);
    });

    it('rounds the rate to one decimal place', async () => {
      qb.getRawMany.mockResolvedValueOnce([
        { campaignId: 'c1', type: 'delivered', count: '3' },
        { campaignId: 'c1', type: 'click', count: '1' },
      ]);

      const result = await service.getEngagementFor(['c1']);

      expect(result.get('c1')?.clickThroughRate).toBe(33.3);
    });
  });

  describe('getExperimentReport', () => {
    const arm = (key: string, id: string, recipients: number, accepted: number) => ({
      id,
      variantKey: key,
      totalTokens: recipients,
      successCount: accepted,
    });

    /** A timezone / send-hour wave split off an arm. Sends on the arm's behalf. */
    const wave = (
      parentCampaignId: string,
      id: string,
      recipients: number,
      accepted: number,
    ) => ({ id, parentCampaignId, totalTokens: recipients, successCount: accepted });

    const arrange = (
      arms: unknown[],
      raw: Array<{ campaignId: string; type: string; count: string }>,
      parent: Record<string, unknown> = {},
      waves: unknown[] = [],
    ) => {
      logRepo.findOne.mockResolvedValueOnce({
        id: 'exp-1',
        variants: [{ key: 'A' }, { key: 'B' }],
        controlDeviceIds: [],
        ...parent,
      });
      // Two reads: the arms under the experiment, then any waves under those
      // arms.
      logRepo.find
        .mockResolvedValueOnce(arms)
        .mockResolvedValueOnce(waves);
      qb.getRawMany.mockResolvedValueOnce(raw);
    };

    it('measures an arm through the waves it was split into', async () => {
      // A local-time experiment: each arm is expanded by timezone and sends
      // nothing itself, so every real send lives in a wave.
      arrange(
        [arm('A', 'a1', 500, 0), arm('B', 'b1', 500, 0)],
        [
          { campaignId: 'a1-ist', type: 'delivered', count: '300' },
          { campaignId: 'a1-ist', type: 'click', count: '30' },
          { campaignId: 'a1-pst', type: 'delivered', count: '100' },
          { campaignId: 'a1-pst', type: 'click', count: '10' },
          { campaignId: 'b1-ist', type: 'delivered', count: '400' },
          { campaignId: 'b1-ist', type: 'click', count: '20' },
        ],
        {},
        [
          wave('a1', 'a1-ist', 300, 300),
          wave('a1', 'a1-pst', 200, 200),
          wave('b1', 'b1-ist', 500, 500),
        ],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');
      const armA = report.arms.find((a) => a.variantKey === 'A')!;

      // Reading the arm row alone reported 0 accepted for every arm, and the
      // verdict stayed "not enough data" however the test actually performed.
      expect(armA.accepted).toBe(500);
      expect(armA.recipients).toBe(500);
      expect(armA.engagement.delivered).toBe(400);
      expect(armA.engagement.clicks).toBe(40);
    });

    it('does not count an expanded arm and its waves twice', async () => {
      arrange(
        [arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)],
        [],
        {},
        [wave('a1', 'a1-ist', 300, 300), wave('a1', 'a1-pst', 200, 200)],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      // The arm's own totals are the audience its waves were split from, so
      // adding both would report 1000 recipients for a 500-device arm.
      expect(report.arms.find((a) => a.variantKey === 'A')!.recipients).toBe(500);
    });

    it('recomputes the arm rate from summed totals rather than averaging waves', async () => {
      arrange(
        [arm('A', 'a1', 10_010, 0), arm('B', 'b1', 100, 100)],
        [
          // A tiny wave that happened to convert perfectly, and a large one
          // that did not.
          { campaignId: 'a1-tiny', type: 'delivered', count: '10' },
          { campaignId: 'a1-tiny', type: 'click', count: '10' },
          { campaignId: 'a1-big', type: 'delivered', count: '10000' },
          { campaignId: 'a1-big', type: 'click', count: '100' },
        ],
        {},
        [wave('a1', 'a1-tiny', 10, 10), wave('a1', 'a1-big', 10_000, 10_000)],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      // 110 clicks over 10010 delivered = 1.1%. Averaging the two waves'
      // rates would have claimed 55%.
      expect(
        report.arms.find((a) => a.variantKey === 'A')!.engagement.clickThroughRate,
      ).toBe(1.1);
    });

    it('reports no rate for an arm nothing has been delivered for yet', async () => {
      arrange([arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)], [], {}, [
        wave('a1', 'a1-ist', 500, 500),
      ]);

      // "Nothing reported yet" is not the same claim as 0%.
      expect(
        (await service.getExperimentReport('proj-1', 'exp-1')).arms.find(
          (a) => a.variantKey === 'A',
        )!.engagement.clickThroughRate,
      ).toBeNull();
    });

    it('reports each arm separately', async () => {
      arrange(
        [arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)],
        [
          { campaignId: 'a1', type: 'delivered', count: '400' },
          { campaignId: 'a1', type: 'click', count: '40' },
          { campaignId: 'b1', type: 'delivered', count: '400' },
          { campaignId: 'b1', type: 'click', count: '20' },
        ],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      expect(report.arms).toHaveLength(2);
      expect(report.arms.find((a) => a.variantKey === 'A')!.engagement.clickThroughRate).toBe(10);
      expect(report.arms.find((a) => a.variantKey === 'B')!.engagement.clickThroughRate).toBe(5);
    });

    it('names a leader when the gap is wide and both arms have volume', async () => {
      arrange(
        [arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)],
        [
          { campaignId: 'a1', type: 'delivered', count: '400' },
          { campaignId: 'a1', type: 'click', count: '40' },
          { campaignId: 'b1', type: 'delivered', count: '400' },
          { campaignId: 'b1', type: 'click', count: '20' },
        ],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      expect(report.leader).toBe('A');
      expect(report.verdict).toMatch(/ahead by 5\.0 percentage points/);
    });

    it('refuses to call a winner on thin volume', async () => {
      arrange(
        [arm('A', 'a1', 10, 10), arm('B', 'b1', 10, 10)],
        [
          { campaignId: 'a1', type: 'delivered', count: '10' },
          { campaignId: 'a1', type: 'click', count: '6' },
          { campaignId: 'b1', type: 'delivered', count: '10' },
          { campaignId: 'b1', type: 'click', count: '1' },
        ],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      // A 50-point gap off six clicks is noise. Declaring a winner here is the
      // number a marketer would act on, so it must not be stated.
      expect(report.leader).toBeNull();
      expect(report.verdict).toMatch(/Too early/);
    });

    it('refuses to call a winner when the arms are close', async () => {
      arrange(
        [arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)],
        [
          { campaignId: 'a1', type: 'delivered', count: '400' },
          { campaignId: 'a1', type: 'click', count: '41' },
          { campaignId: 'b1', type: 'delivered', count: '400' },
          { campaignId: 'b1', type: 'click', count: '40' },
        ],
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      expect(report.leader).toBeNull();
      expect(report.verdict).toMatch(/No clear difference/);
    });

    it('says nothing is reported yet rather than declaring a tie', async () => {
      arrange([arm('A', 'a1', 500, 500), arm('B', 'b1', 500, 500)], []);

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      expect(report.leader).toBeNull();
      expect(report.verdict).toMatch(/No results yet/);
    });

    it('reports the held-back control size', async () => {
      arrange(
        [arm('A', 'a1', 5, 5), arm('B', 'b1', 5, 5)],
        [],
        { controlDeviceIds: ['d1', 'd2', 'd3'] },
      );

      const report = await service.getExperimentReport('proj-1', 'exp-1');

      expect(report.controlSize).toBe(3);
    });

    it('handles a campaign that is not an experiment', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'c1', variants: null });
      logRepo.find.mockResolvedValueOnce([]);

      const report = await service.getExperimentReport('proj-1', 'c1');

      expect(report.isExperiment).toBe(false);
      expect(report.arms).toEqual([]);
    });

    it('is project-scoped', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);
      await expect(
        service.getExperimentReport('proj-1', 'nope'),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('getCampaignReport', () => {
    it('refuses a campaign belonging to another project', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.getCampaignReport('proj-1', 'camp-x'),
      ).rejects.toThrow(NotFoundException);
    });

    it('returns the rollup for a campaign that exists', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'camp-1' });
      qb.getRawMany.mockResolvedValueOnce([
        { campaignId: 'camp-1', type: 'delivered', count: '8' },
        { campaignId: 'camp-1', type: 'click', count: '2' },
      ]);

      await expect(
        service.getCampaignReport('proj-1', 'camp-1'),
      ).resolves.toMatchObject({ delivered: 8, clicks: 2, clickThroughRate: 25 });
    });
  });
});
