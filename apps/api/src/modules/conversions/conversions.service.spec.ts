import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { ConversionsService } from './conversions.service';
import { ConversionEventEntity } from './entities/conversion-event.entity';
import { ClickEventEntity } from '../analytics/entities/click-event.entity';
import { LinksService } from '../links/links.service';
import { WebhooksService } from '../webhooks/webhooks.service';
import { AttributionService } from '../attribution/attribution.service';

import { TrackingConsentService } from '../consent/tracking-consent.service';

/** Nobody is do-not-track unless a test says so. */
const trackingConsent = {
  isDoNotTrack: jest.fn(async (_subject: unknown) => false),
  withoutDoNotTrack: jest.fn(async (_projectId: string, ids: string[]) => ids),
  recordDrop: jest.fn(),
};

describe('ConversionsService', () => {
  let service: ConversionsService;
  let conversionRepo: { create: jest.Mock; save: jest.Mock };
  let clickEventRepo: { findOne: jest.Mock };
  let linksService: { findOne: jest.Mock; findByShortCode: jest.Mock };
  let webhooksService: { fireWebhook: jest.Mock };
  let attributionService: { attributeAllModels: jest.Mock };

  beforeEach(async () => {
    conversionRepo = {
      create: jest.fn((x) => x),
      save: jest.fn((x) =>
        Promise.resolve({
          id: 'conv-1',
          convertedAt: new Date('2024-01-10'),
          ...x,
        }),
      ),
    };

    clickEventRepo = {
      findOne: jest.fn(),
    };

    linksService = {
      findOne: jest.fn(),
      findByShortCode: jest.fn(),
    };

    webhooksService = {
      fireWebhook: jest.fn().mockResolvedValue(undefined),
    };

    attributionService = {
      attributeAllModels: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        { provide: TrackingConsentService, useValue: trackingConsent },
        ConversionsService,
        {
          provide: getRepositoryToken(ConversionEventEntity),
          useValue: conversionRepo,
        },
        {
          provide: getRepositoryToken(ClickEventEntity),
          useValue: clickEventRepo,
        },
        { provide: LinksService, useValue: linksService },
        { provide: WebhooksService, useValue: webhooksService },
        { provide: AttributionService, useValue: attributionService },
      ],
    }).compile();

    service = module.get<ConversionsService>(ConversionsService);
  });

  // ---------------------------------------------------------------------------
  // trackConversion — input validation
  // ---------------------------------------------------------------------------
  describe('trackConversion — input validation', () => {
    it('throws BadRequestException when neither shortCode nor linkId is provided', async () => {
      await expect(
        service.trackConversion({ eventType: 'signup' } as any),
      ).rejects.toThrow(BadRequestException);
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — link resolution
  // ---------------------------------------------------------------------------
  describe('trackConversion — link resolution', () => {
    it('resolves link via linkId when linkId is provided', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
      } as any);

      expect(linksService.findOne).toHaveBeenCalledWith('link-1');
      expect(linksService.findByShortCode).not.toHaveBeenCalled();
    });

    it('resolves link via shortCode when linkId is not provided', async () => {
      linksService.findByShortCode.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        shortCode: 'abc',
        eventType: 'signup',
      } as any);

      expect(linksService.findByShortCode).toHaveBeenCalledWith('abc');
      expect(linksService.findOne).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — project scoping
  // ---------------------------------------------------------------------------
  describe('trackConversion — project scoping', () => {
    it('throws BadRequestException when link projectId does not match expectedProjectId', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-other',
      });

      await expect(
        service.trackConversion(
          { linkId: 'link-1', eventType: 'signup' } as any,
          'proj-expected',
        ),
      ).rejects.toThrow('Link does not belong to your project');
    });

    it('allows the conversion when expectedProjectId matches the link', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion(
        { linkId: 'link-1', eventType: 'signup' } as any,
        'proj-1',
      );

      expect(conversionRepo.save).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — click linking
  // ---------------------------------------------------------------------------
  describe('trackConversion — click linking', () => {
    it('links to the most recent click event via clickEventId', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce({ id: 'click-42' });

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'purchase',
      } as any);

      expect(clickEventRepo.findOne).toHaveBeenCalledWith({
        where: { linkId: 'link-1' },
        order: { clickedAt: 'DESC' },
      });

      const created = conversionRepo.create.mock.calls[0][0];
      expect(created.clickEventId).toBe('click-42');
      expect(created.linkId).toBe('link-1');
      expect(created.eventType).toBe('purchase');
    });

    it('stores null for clickEventId when no prior click exists', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
      } as any);

      const created = conversionRepo.create.mock.calls[0][0];
      expect(created.clickEventId).toBeNull();
    });

    it('stores externalUserId and metadata from the DTO', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
        externalUserId: 'user-99',
        metadata: { plan: 'pro' },
      } as any);

      const created = conversionRepo.create.mock.calls[0][0];
      expect(created.externalUserId).toBe('user-99');
      expect(created.metadata).toEqual({ plan: 'pro' });
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — webhook firing
  // ---------------------------------------------------------------------------
  describe('trackConversion — webhooks', () => {
    it('fires a webhook with conversion payload after save', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
        externalUserId: 'user-99',
      } as any);

      expect(webhooksService.fireWebhook).toHaveBeenCalledWith(
        'proj-1',
        'conversion',
        expect.objectContaining({
          linkId: 'link-1',
          conversionId: 'conv-1',
          eventType: 'signup',
          externalUserId: 'user-99',
        }),
      );
    });

    it('swallows webhook failures without throwing', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);
      webhooksService.fireWebhook.mockRejectedValueOnce(new Error('webhook down'));

      await expect(
        service.trackConversion({
          linkId: 'link-1',
          eventType: 'signup',
        } as any),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — attribution
  // ---------------------------------------------------------------------------
  describe('trackConversion — attribution', () => {
    it('runs multi-touch attribution using externalUserId as distinctId', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
        externalUserId: 'user-99',
      } as any);

      // Attribution is fire-and-forget — give the microtask queue a tick
      await new Promise((r) => setImmediate(r));

      expect(attributionService.attributeAllModels).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          conversionId: 'conv-1',
          distinctId: 'user-99',
        }),
      );
    });

    it('does NOT run attribution when there is neither distinctId nor externalUserId', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      await service.trackConversion({
        linkId: 'link-1',
        eventType: 'signup',
      } as any);

      await new Promise((r) => setImmediate(r));

      expect(attributionService.attributeAllModels).not.toHaveBeenCalled();
    });

    it('swallows attribution failures without throwing', async () => {
      linksService.findOne.mockResolvedValueOnce({
        id: 'link-1',
        projectId: 'proj-1',
      });
      clickEventRepo.findOne.mockResolvedValueOnce(null);
      attributionService.attributeAllModels.mockRejectedValueOnce(
        new Error('attribution failed'),
      );

      await expect(
        service.trackConversion({
          linkId: 'link-1',
          eventType: 'signup',
          externalUserId: 'user-99',
        } as any),
      ).resolves.toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // trackConversion — do-not-track
  // ---------------------------------------------------------------------------
  describe('trackConversion — do-not-track', () => {
    beforeEach(() => {
      trackingConsent.isDoNotTrack.mockClear();
      trackingConsent.recordDrop.mockClear();
    });

    it('records nothing for a do-not-track person: no row, webhook or attribution', async () => {
      linksService.findOne.mockResolvedValueOnce({ id: 'link-1', projectId: 'proj-1' });
      trackingConsent.isDoNotTrack.mockResolvedValueOnce(true);

      const result = await service.trackConversion(
        { linkId: 'link-1', eventType: 'purchase', externalUserId: 'user-99' } as any,
        'proj-1',
      );

      expect(result).toBeNull();
      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith({
        projectId: 'proj-1',
        externalUserId: 'user-99',
      });
      expect(conversionRepo.save).not.toHaveBeenCalled();
      expect(webhooksService.fireWebhook).not.toHaveBeenCalled();
      expect(attributionService.attributeAllModels).not.toHaveBeenCalled();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('conversion');
    });

    it('still refuses a link from another project before asking about consent', async () => {
      linksService.findOne.mockResolvedValueOnce({ id: 'link-1', projectId: 'other' });
      await expect(
        service.trackConversion(
          { linkId: 'link-1', eventType: 'purchase', externalUserId: 'user-99' } as any,
          'proj-1',
        ),
      ).rejects.toThrow('Link does not belong to your project');
      expect(trackingConsent.isDoNotTrack).not.toHaveBeenCalled();
    });

    it('records a conversion that names nobody without asking', async () => {
      linksService.findOne.mockResolvedValueOnce({ id: 'link-1', projectId: 'proj-1' });
      clickEventRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.trackConversion({ linkId: 'link-1', eventType: 'signup' } as any);

      expect(result).not.toBeNull();
      expect(conversionRepo.save).toHaveBeenCalledTimes(1);
      expect(trackingConsent.isDoNotTrack).not.toHaveBeenCalled();
    });
  });
});
