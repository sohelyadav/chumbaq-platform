import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getQueueToken } from '@nestjs/bullmq';
import { NotFoundException, BadRequestException } from '@nestjs/common';
import { PushNotificationsService } from './push-notifications.service';
import { PushConfigEntity } from './entities/push-config.entity';
import { PushNotificationLogEntity } from './entities/push-notification-log.entity';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { FcmProvider } from './services/fcm.provider';
import { PushAnalyticsService } from './push-analytics.service';
import { PushTemplatesService } from './push-templates.service';
import { ChannelCredentialsService } from './channel-credentials.service';
import { PushTokensService } from '../push-tokens/push-tokens.service';
import { IdentityService } from '../identity/identity.service';
import { SegmentsService } from '../segments/segments.service';
import { SegmentEvaluationService } from '../segments/segment-evaluation.service';
import { QUEUE_PUSH_CAMPAIGN } from '../../queue/queue.constants';
import { ProjectActivityService } from '../project-activity/project-activity.service';

const REQUESTER = { userId: 'user-1', context: { ipAddress: null, userAgent: null } };

describe('PushNotificationsService', () => {
  let service: PushNotificationsService;

  const configRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    // configure and updateSettings write in a transaction; its manager hands back this repository.
    manager: {
      transaction: async (work: (m: unknown) => unknown) => work({ query: jest.fn(), getRepository: () => configRepo }),
    },
  };
  const activity = { record: jest.fn() };
  const CTX = { ipAddress: null, userAgent: null };

  const logRepo = {
    find: jest.fn(),
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    create: jest.fn(),
    // A campaign row and its activity entry are written in one transaction.
    manager: {
      transaction: async (work: (m: unknown) => unknown) => work({ getRepository: () => logRepo }),
    },
  };

  const cryptoService = {
    encrypt: jest.fn(),
    decrypt: jest.fn(),
  };

  const fcmProvider = {
    send: jest.fn(),
    validateCredentials: jest.fn(),
  };

  const pushAnalytics = {
    getEngagementFor: jest.fn().mockResolvedValue(new Map()),
  };

  const pushTemplates = {
    recordUse: jest.fn(),
  };

  const channelCredentials = {
    upsert: jest.fn(),
    replace: jest.fn(async () => true),
    getPlaintext: jest.fn(),
    find: jest.fn(),
    configuredPushProviders: jest.fn().mockResolvedValue(['fcm']),
  };

  const pushTokensService = {
    countActiveTokensByProject: jest.fn(),
    countTokensByDeviceIdentityIds: jest.fn(),
    markTokenInvalid: jest.fn(),
    isTokenOptedOut: jest.fn(async (_projectId: string, _token: string) => false),
  };

  const identityService = {
    findByDistinctId: jest.fn(),
    // Behaves like the database: only ids seeded in this project are kept.
    idsInProject: jest.fn(async (projectId: string, ids: string[]) =>
      ids.filter((id) => (projectDevices[projectId] ?? []).includes(id)),
    ),
  };
  const projectDevices: Record<string, string[]> = {};

  const segmentsService = { findOne: jest.fn() };
  const segmentEvaluation = { enumerate: jest.fn(), resolveDeviceIdentityIds: jest.fn() };

  const pushQueue = {
    add: jest.fn(),
  };

  const validFcmJson = JSON.stringify({
    project_id: 'fcm-proj',
    private_key: '-----BEGIN PRIVATE KEY-----',
    client_email: 'x@y.iam.gserviceaccount.com',
  });

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushNotificationsService,
        { provide: getRepositoryToken(PushConfigEntity), useValue: configRepo },
        { provide: getRepositoryToken(PushNotificationLogEntity), useValue: logRepo },
        { provide: CredentialsCryptoService, useValue: cryptoService },
        { provide: FcmProvider, useValue: fcmProvider },
        { provide: PushAnalyticsService, useValue: pushAnalytics },
        { provide: PushTemplatesService, useValue: pushTemplates },
        { provide: ChannelCredentialsService, useValue: channelCredentials },
        { provide: PushTokensService, useValue: pushTokensService },
        { provide: IdentityService, useValue: identityService },
        { provide: SegmentsService, useValue: segmentsService },
        { provide: SegmentEvaluationService, useValue: segmentEvaluation },
        { provide: getQueueToken(QUEUE_PUSH_CAMPAIGN), useValue: pushQueue },
        { provide: ProjectActivityService, useValue: activity },
      ],
    }).compile();

    service = module.get<PushNotificationsService>(PushNotificationsService);
  });

  // ---------------------------------------------------------------------------
  // configure
  // ---------------------------------------------------------------------------
  describe('configure', () => {
    it('throws on invalid JSON', async () => {
      await expect(
        service.configure({ projectId: 'proj-1', fcmServiceAccountJson: '{not json' }, 'user-1', CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('throws when required FCM fields are missing', async () => {
      await expect(
        service.configure({
          projectId: 'proj-1',
          fcmServiceAccountJson: JSON.stringify({ project_id: 'x' }),
        }, 'user-1', CTX),
      ).rejects.toThrow(BadRequestException);
    });

    it('creates a new config when none exists', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);
      cryptoService.encrypt.mockReturnValueOnce({
        ciphertext: 'ct',
        iv: 'iv',
        tag: 'tag',
      });
      configRepo.create.mockImplementation((obj) => ({ ...obj }));
      configRepo.save.mockImplementation(async (obj) => ({ id: 'cfg-1', ...obj }));

      const result = await service.configure({
        projectId: 'proj-1',
        fcmServiceAccountJson: validFcmJson,
      }, 'user-1', CTX);

      // Credentials live in push_channel_credentials, one row per channel.
      // The config row carries only the sending policy shared across channels.
      expect(channelCredentials.replace).toHaveBeenCalledWith(
        expect.anything(),
        'proj-1',
        'fcm',
        validFcmJson,
      );
      expect(configRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'proj-1', isActive: true }),
      );
      expect(result).toEqual({
        id: 'cfg-1',
        projectId: 'proj-1',
        firebaseProjectId: 'fcm-proj',
      });
    });

    it('verifies the credentials with Firebase before storing them', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);
      cryptoService.encrypt.mockReturnValueOnce({
        ciphertext: 'ct',
        iv: 'iv',
        tag: 'tag',
      });
      configRepo.create.mockImplementation((obj) => ({ ...obj }));
      configRepo.save.mockImplementation(async (obj) => ({ id: 'cfg-1', ...obj }));

      await service.configure({
        projectId: 'proj-1',
        fcmServiceAccountJson: validFcmJson,
      }, 'user-1', CTX);

      expect(fcmProvider.validateCredentials).toHaveBeenCalledWith(
        expect.objectContaining({ project_id: 'fcm-proj' }),
      );
    });

    it('rejects credentials Firebase will not accept, and stores nothing', async () => {
      fcmProvider.validateCredentials.mockRejectedValueOnce(
        new Error('Token exchange failed: invalid_grant'),
      );

      await expect(
        service.configure({
          projectId: 'proj-1',
          fcmServiceAccountJson: validFcmJson,
        }, 'user-1', CTX),
      ).rejects.toThrow(/invalid_grant/);

      // Structurally valid JSON with a broken key would otherwise be stored
      // and only fail at the first campaign, hours later.
      expect(configRepo.save).not.toHaveBeenCalled();
      expect(cryptoService.encrypt).not.toHaveBeenCalled();
    });

    it('passes a refused token_uri through as it is, and stores nothing', async () => {
      // Our own refusal, not Firebase's: prefixing it with "Firebase rejected"
      // would send the tenant looking in the wrong place.
      fcmProvider.validateCredentials.mockRejectedValueOnce(
        new BadRequestException(
          "The service account's token_uri must be Google's token endpoint.",
        ),
      );

      const error = await service
        .configure({ projectId: 'proj-1', fcmServiceAccountJson: validFcmJson }, 'user-1', CTX)
        .catch((e) => e);

      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(
        "The service account's token_uri must be Google's token endpoint.",
      );
      expect(channelCredentials.replace).not.toHaveBeenCalled();
    });

    it('updates existing config in place', async () => {
      const existing = {
        id: 'cfg-1',
        projectId: 'proj-1',
        fcmCredentialsEncrypted: 'old',
        fcmCredentialsIv: 'old',
        fcmCredentialsTag: 'old',
        isActive: false,
      };
      configRepo.findOne.mockResolvedValueOnce(existing);
      cryptoService.encrypt.mockReturnValueOnce({
        ciphertext: 'new-ct',
        iv: 'new-iv',
        tag: 'new-tag',
      });
      configRepo.save.mockImplementation(async (obj) => obj);

      const result = await service.configure({
        projectId: 'proj-1',
        fcmServiceAccountJson: validFcmJson,
      }, 'user-1', CTX);

      expect(configRepo.create).not.toHaveBeenCalled();
      expect(result.id).toBe('cfg-1');
      // Re-uploading a key must not reset the project's sending policy —
      // frequency cap, quiet hours and rate limit live on this row.
      expect(channelCredentials.replace).toHaveBeenCalledWith(
        expect.anything(),
        'proj-1',
        'fcm',
        validFcmJson,
      );
      expect(existing.isActive).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getConfigStatus
  // ---------------------------------------------------------------------------
  describe('getConfigStatus', () => {
    const storedConfig = {
      isActive: true,
      fcmCredentialsEncrypted: 'ct',
      fcmCredentialsIv: 'iv',
      fcmCredentialsTag: 'tag',
      updatedAt: new Date('2026-09-06T10:00:00Z'),
    };

    it('returns configured=false when no config row', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);

      const status = await service.getConfigStatus('proj-1');

      expect(status).toEqual({
        configured: false,
        isActive: false,
        firebaseProjectId: null,
        clientEmail: null,
        updatedAt: null,
        frequencyCapPerDay: null,
        quietHoursStart: null,
        quietHoursEnd: null,
        maxSendsPerMinute: null,
      });
    });

    it('reports which Firebase account is connected, not just that one is', async () => {
      configRepo.findOne.mockResolvedValueOnce(storedConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(
        JSON.stringify({
          project_id: 'chumbaq-demo-4f21a',
          client_email: 'firebase-adminsdk@chumbaq-demo-4f21a.iam.gserviceaccount.com',
          private_key: '-----BEGIN PRIVATE KEY-----SECRET-----',
        }),
      );

      const status = await service.getConfigStatus('proj-1');

      expect(status).toMatchObject({
        configured: true,
        isActive: true,
        firebaseProjectId: 'chumbaq-demo-4f21a',
        clientEmail:
          'firebase-adminsdk@chumbaq-demo-4f21a.iam.gserviceaccount.com',
      });
    });

    it('never lets the private key out of the server', async () => {
      configRepo.findOne.mockResolvedValueOnce(storedConfig);
      cryptoService.decrypt.mockReturnValueOnce(
        JSON.stringify({
          project_id: 'p',
          client_email: 'a@b.com',
          private_key: '-----BEGIN PRIVATE KEY-----SECRET-----',
        }),
      );

      const status = await service.getConfigStatus('proj-1');

      // The whole credential object is decrypted to read two fields; spreading
      // it would ship the signing key to every dashboard poll.
      expect(JSON.stringify(status)).not.toContain('SECRET');
      expect(JSON.stringify(status)).not.toContain('private_key');
    });

    it('still reports configured when the stored credentials cannot be read', async () => {
      configRepo.findOne.mockResolvedValueOnce(storedConfig);
      channelCredentials.getPlaintext.mockImplementationOnce(() => {
        throw new Error('bad key');
      });

      const status = await service.getConfigStatus('proj-1');

      // Something IS stored; claiming otherwise would send the user to
      // re-upload when the real problem is a rotated encryption key.
      expect(status).toMatchObject({
        configured: true,
        firebaseProjectId: null,
        clientEmail: null,
      });
    });
  });

  describe('updateSettings', () => {
    it('stores a frequency cap', async () => {
      const config: any = { projectId: 'proj-1', frequencyCapPerDay: null };
      configRepo.findOne.mockResolvedValueOnce(config);
      configRepo.update.mockImplementation(async (_criteria: unknown, patch: object) => Object.assign(config, patch));

      await expect(
        service.updateSettings({ projectId: 'proj-1', frequencyCapPerDay: 3 }, 'user-1', CTX),
      ).resolves.toMatchObject({ frequencyCapPerDay: 3 });
      expect(config.frequencyCapPerDay).toBe(3);
    });

    it('clears the cap when none is given', async () => {
      const config: any = { projectId: 'proj-1', frequencyCapPerDay: 5 };
      configRepo.findOne.mockResolvedValueOnce(config);
      configRepo.update.mockImplementation(async (_criteria: unknown, patch: object) => Object.assign(config, patch));

      // Clearing also stops the server writing per-recipient rows, so a
      // project that turns capping off stops paying for it immediately.
      await expect(
        service.updateSettings({ projectId: 'proj-1' }, 'user-1', CTX),
      ).resolves.toMatchObject({ frequencyCapPerDay: null });
      expect(config.frequencyCapPerDay).toBeNull();
    });

    it('stores a quiet-hours window', async () => {
      const config: any = { projectId: 'proj-1' };
      configRepo.findOne.mockResolvedValueOnce(config);
      configRepo.update.mockImplementation(async (_criteria: unknown, patch: object) => Object.assign(config, patch));

      await service.updateSettings({
        projectId: 'proj-1',
        quietHoursStart: '22:00',
        quietHoursEnd: '08:00',
      }, 'user-1', CTX);

      expect(config.quietHoursStart).toBe('22:00');
      expect(config.quietHoursEnd).toBe('08:00');
    });

    it('refuses half a quiet-hours window', async () => {
      configRepo.findOne.mockResolvedValueOnce({ projectId: 'proj-1' });

      // A start with no end would silently do nothing, which reads as the
      // feature being broken rather than misconfigured.
      await expect(
        service.updateSettings({ projectId: 'proj-1', quietHoursStart: '22:00' }, 'user-1', CTX),
      ).rejects.toThrow(/both a start and an end/);
    });

    it('refuses a project with no push config', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.updateSettings({ projectId: 'proj-1', frequencyCapPerDay: 3 }, 'user-1', CTX),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('previewAudience', () => {
    it('counts the whole project when no target is given', async () => {
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(26);

      await expect(
        service.previewAudience({ projectId: 'proj-1' }),
      ).resolves.toEqual({
        targetType: 'project',
        totalTokens: 26,
        deviceCount: null,
      });
    });

    it('resolves a segment to devices and counts their tokens', async () => {
      segmentsService.findOne.mockResolvedValueOnce({
        id: 'seg-1',
        projectId: 'proj-1',
        evaluationMode: 'live',
      });
      segmentEvaluation.enumerate.mockResolvedValueOnce(['p1', 'p2']);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValueOnce([
        'dev-1',
        'dev-2',
        'dev-3',
      ]);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(4);

      const preview = await service.previewAudience({
        projectId: 'proj-1',
        segmentId: 'seg-1',
      });

      // Three devices carrying four tokens: one person has two installs. The
      // preview must not conflate the two numbers.
      expect(preview).toEqual({
        targetType: 'segment',
        totalTokens: 4,
        deviceCount: 3,
      });
    });

    it('does not enqueue anything', async () => {
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);

      await service.previewAudience({ projectId: 'proj-1' });

      expect(pushQueue.add).not.toHaveBeenCalled();
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('reports zero rather than throwing when nobody would be reached', async () => {
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(0);

      // send() rejects an empty audience, but a preview of zero is a useful
      // answer, not an error — it is exactly what the user asked to find out.
      await expect(
        service.previewAudience({ projectId: 'proj-1' }),
      ).resolves.toMatchObject({ totalTokens: 0 });
    });
  });

  // ---------------------------------------------------------------------------
  // send — enqueue only; delivery happens in the worker (see PushCampaignProcessor)
  // ---------------------------------------------------------------------------
  describe('send', () => {
    const baseDto = {
      projectId: 'proj-1',
      title: 'Hello',
      body: 'World',
    };

    const activeConfig = {
      fcmCredentialsEncrypted: 'ct',
      fcmCredentialsIv: 'iv',
      fcmCredentialsTag: 'tag',
      isActive: true,
    };

    it('throws NotFoundException when no active config exists', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.send(baseDto, REQUESTER)).rejects.toThrow(NotFoundException);
      expect(pushQueue.add).not.toHaveBeenCalled();
    });

    it('throws BadRequestException when the project has no active tokens', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(0);

      await expect(service.send(baseDto, REQUESTER)).rejects.toThrow(BadRequestException);
      expect(pushQueue.add).not.toHaveBeenCalled();
    });

    it('writes a queued log row and enqueues a job without contacting FCM', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(1500);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      const result = await service.send(baseDto, REQUESTER);

      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          title: 'Hello',
          totalTokens: 1500,
          processedTokens: 0,
          successCount: 0,
          failureCount: 0,
          status: 'queued',
          targetType: 'project',
          targetDeviceIds: null,
        }),
      );
      expect(pushQueue.add).toHaveBeenCalledWith(
        'dispatch-campaign',
        { logId: 'log-1', projectId: 'proj-1' },
        { jobId: 'log-1' },
      );
      expect(fcmProvider.send).not.toHaveBeenCalled();
      expect(cryptoService.decrypt).not.toHaveBeenCalled();
      expect(result.status).toBe('queued');
    });

    it('records the use when a campaign is composed from a template', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, templateId: 'tpl-1' }, REQUESTER);

      // Ordering a template list by use is only honest if use is counted.
      expect(pushTemplates.recordUse).toHaveBeenCalledWith('proj-1', 'tpl-1');
    });

    it('does not store templateId on the campaign', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, templateId: 'tpl-1' }, REQUESTER);

      // The content was copied at compose time. Keeping a live reference would
      // let editing a template rewrite what an already-sent campaign said.
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.not.objectContaining({ templateId: expect.anything() }),
      );
    });

    it('still sends when recording the template use fails', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));
      pushTemplates.recordUse.mockRejectedValueOnce(new Error('db down'));

      // A usage counter is never worth failing a send over.
      await expect(
        service.send({ ...baseDto, templateId: 'tpl-1' }, REQUESTER),
      ).resolves.toMatchObject({ id: 'log-1' });
      expect(pushQueue.add).toHaveBeenCalled();
    });

    it('does not touch the template table for an ordinary campaign', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send(baseDto, REQUESTER);

      expect(pushTemplates.recordUse).not.toHaveBeenCalled();
    });

    it('persists imageUrl so the worker can send it', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(1);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, imageUrl: 'https://cdn/x.png' }, REQUESTER);

      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ imageUrl: 'https://cdn/x.png' }),
      );
    });

    it('targets devices when deviceIdentityIds are provided', async () => {
      projectDevices[baseDto.projectId] = ['dev-1', 'dev-2'];
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(2);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, deviceIdentityIds: ['dev-1', 'dev-2'] }, REQUESTER);

      // null is the project's frequency cap: unset here, but it must travel
      // with the count so the preview matches what the send will reach.
      expect(pushTokensService.countTokensByDeviceIdentityIds).toHaveBeenCalledWith(
        'proj-1',
        ['dev-1', 'dev-2'],
        null,
      );
      expect(pushTokensService.countActiveTokensByProject).not.toHaveBeenCalled();
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'devices',
          targetDeviceIds: ['dev-1', 'dev-2'],
        }),
      );
    });

    it('keeps only this project\'s devices and never counts another tenant\'s', async () => {
      projectDevices[baseDto.projectId] = ['dev-1'];
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(1);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, deviceIdentityIds: ['dev-1', 'other-tenant-dev'] }, REQUESTER);

      expect(pushTokensService.countTokensByDeviceIdentityIds).toHaveBeenCalledWith('proj-1', ['dev-1'], null);
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ targetType: 'devices', targetDeviceIds: ['dev-1'] }),
      );
    });

    it('refuses, rather than broadcasting, when no device belongs to the project', async () => {
      projectDevices[baseDto.projectId] = [];
      configRepo.findOne.mockResolvedValueOnce(activeConfig);

      await expect(
        service.send({ ...baseDto, deviceIdentityIds: ['other-tenant-dev'] }, REQUESTER),
      ).rejects.toThrow('None of these devices belong to this project.');
      expect(pushTokensService.countActiveTokensByProject).not.toHaveBeenCalled();
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('falls back to project-wide targeting when deviceIdentityIds is empty', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(3);
      logRepo.create.mockImplementation((obj) => obj);
      logRepo.save.mockImplementation(async (obj) => ({ id: 'log-1', ...obj }));

      await service.send({ ...baseDto, deviceIdentityIds: [] }, REQUESTER);

      expect(pushTokensService.countActiveTokensByProject).toHaveBeenCalled();
      expect(pushTokensService.countTokensByDeviceIdentityIds).not.toHaveBeenCalled();
    });

    it('resolves a segment to devices and records the segment on the log', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      segmentsService.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1', evaluationMode: 'live',
      });
      segmentEvaluation.enumerate.mockResolvedValueOnce(['user-1', 'device:d3']);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValueOnce(['d1', 'd2', 'd3']);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(3);
      logRepo.create.mockImplementation((o) => o);
      logRepo.save.mockImplementation(async (o) => ({ id: 'log-1', ...o }));

      await service.send({ ...baseDto, segmentId: 'seg-1' }, REQUESTER);

      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          targetType: 'segment',
          segmentId: 'seg-1',
          targetDeviceIds: ['d1', 'd2', 'd3'],
          totalTokens: 3,
          status: 'queued',
        }),
      );
      expect(fcmProvider.send).not.toHaveBeenCalled();
    });

    it('pages through every member rather than stopping at the first page', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      segmentsService.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1', evaluationMode: 'live',
      });
      const page1 = Array.from({ length: 1000 }, (_, i) => `u${i}`);
      segmentEvaluation.enumerate
        .mockResolvedValueOnce(page1)
        .mockResolvedValueOnce(['u1000']);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValueOnce(['d1']);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(1);
      logRepo.create.mockImplementation((o) => o);
      logRepo.save.mockImplementation(async (o) => ({ id: 'log-1', ...o }));

      await service.send({ ...baseDto, segmentId: 'seg-1' }, REQUESTER);

      expect(segmentEvaluation.enumerate).toHaveBeenCalledTimes(2);
      expect(segmentEvaluation.enumerate.mock.calls[1][1]).toBe('u999');
    });

    it('rejects an audience larger than the cap instead of writing a huge array', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      segmentsService.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1', evaluationMode: 'live',
      });
      segmentEvaluation.enumerate.mockImplementation(async () =>
        Array.from({ length: 1000 }, (_, i) => `u${Math.random()}${i}`),
      );

      await expect(service.send({ ...baseDto, segmentId: 'seg-1' }, REQUESTER))
        .rejects.toThrow(BadRequestException);
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('rejects a segment with no members before enqueueing', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      segmentsService.findOne.mockResolvedValueOnce({
        id: 'seg-1', projectId: 'proj-1', evaluationMode: 'live',
      });
      segmentEvaluation.enumerate.mockResolvedValueOnce([]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValueOnce([]);
      pushTokensService.countTokensByDeviceIdentityIds.mockResolvedValueOnce(0);

      await expect(service.send({ ...baseDto, segmentId: 'seg-1' }, REQUESTER))
        .rejects.toThrow(BadRequestException);
      expect(pushQueue.add).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // sendToUser — delegates to send() with resolved identities
  // ---------------------------------------------------------------------------
  describe('testSend', () => {
    const activeConfig = {
      id: 'cfg-1',
      projectId: 'proj-1',
      fcmCredentialsEncrypted: 'ct',
      fcmCredentialsIv: 'iv',
      fcmCredentialsTag: 'tag',
      isActive: true,
    };

    const credentials = {
      project_id: 'test-project',
      private_key: 'k',
      client_email: 'sa@example.com',
    };

    it('throws NotFoundException when the project has no active config', async () => {
      configRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.testSend({ projectId: 'proj-1', token: 'tok' }),
      ).rejects.toThrow(NotFoundException);
    });

    it('refuses a test send to a device that opted out of push, without calling FCM', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.isTokenOptedOut.mockResolvedValueOnce(true);

      const result = await service.testSend({ projectId: 'proj-1', token: 'tok' });

      expect(pushTokensService.isTokenOptedOut).toHaveBeenCalledWith('proj-1', 'tok');
      expect(result).toEqual({
        delivered: false,
        dryRun: false,
        error: 'This device has opted out of push notifications.',
        errorCode: 'opted_out',
      });
      expect(fcmProvider.send).not.toHaveBeenCalled();
    });

    it('still runs a dry run against an opted-out device, which delivers nothing', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockResolvedValueOnce({ successCount: 1, failureCount: 0, failures: [] });

      const result = await service.testSend({ projectId: 'proj-1', token: 'tok', dryRun: true });

      expect(pushTokensService.isTokenOptedOut).not.toHaveBeenCalled();
      expect(result).toEqual({ delivered: true, dryRun: true });
    });

    it('reports a delivered test send', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockResolvedValueOnce({
        successCount: 1,
        failureCount: 0,
        failures: [],
        resolvedCount: 1,
        retryReason: null,
      });

      await expect(
        service.testSend({ projectId: 'proj-1', token: 'tok' }),
      ).resolves.toEqual({ delivered: true, dryRun: false });
    });

    it('passes dryRun through so FCM validates without delivering', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockResolvedValueOnce({
        successCount: 1,
        failureCount: 0,
        failures: [],
        resolvedCount: 1,
        retryReason: null,
      });

      const result = await service.testSend({
        projectId: 'proj-1',
        token: 'tok',
        dryRun: true,
      });

      expect(fcmProvider.send).toHaveBeenCalledWith(
        credentials,
        ['tok'],
        expect.any(Object),
        { dryRun: true },
      );
      expect(result).toEqual({ delivered: true, dryRun: true });
    });

    it('surfaces the FCM error code for a permanently bad token', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockResolvedValueOnce({
        successCount: 0,
        failureCount: 1,
        failures: [
          {
            token: 'tok',
            error: 'FCM error 404: ...',
            errorCode: 'UNREGISTERED',
            retryable: false,
          },
        ],
        resolvedCount: 1,
        retryReason: null,
      });

      await expect(
        service.testSend({ projectId: 'proj-1', token: 'tok' }),
      ).resolves.toMatchObject({
        delivered: false,
        errorCode: 'UNREGISTERED',
      });
    });

    it('reports a rejected service account instead of raising a 500', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockRejectedValueOnce(
        new Error('Token exchange failed: {"error":"invalid_grant"}'),
      );

      await expect(
        service.testSend({ projectId: 'proj-1', token: 'tok' }),
      ).resolves.toMatchObject({
        delivered: false,
        error: expect.stringContaining('invalid_grant'),
      });
    });

    it('reports a still-retrying failure, which never lands in failures[]', async () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      channelCredentials.getPlaintext.mockResolvedValueOnce(JSON.stringify(credentials));
      fcmProvider.send.mockResolvedValueOnce({
        successCount: 0,
        failureCount: 0,
        failures: [],
        resolvedCount: 0,
        retryReason: 'FCM error 429: slow down',
      });

      await expect(
        service.testSend({ projectId: 'proj-1', token: 'tok' }),
      ).resolves.toMatchObject({
        delivered: false,
        error: 'FCM error 429: slow down',
      });
    });
  });

  describe('scheduling', () => {
    const baseDto = { projectId: 'proj-1', title: 'Hello', body: 'World' };
    const activeConfig = {
      fcmCredentialsEncrypted: 'ct',
      fcmCredentialsIv: 'iv',
      fcmCredentialsTag: 'tag',
      isActive: true,
    };

    const arrange = () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.countActiveTokensByProject.mockResolvedValueOnce(10);
      logRepo.create.mockImplementation((o) => o);
      logRepo.save.mockImplementation(async (o) => ({ id: 'log-1', ...o }));
    };

    it('holds a future campaign as scheduled without enqueuing it', async () => {
      arrange();
      const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();

      const log = await service.send({ ...baseDto, scheduledAt: future }, REQUESTER);

      expect(log.status).toBe('scheduled');
      // No job now: the promotion sweep owns dispatch. A BullMQ delay would
      // put the schedule in Redis where it could not be listed or cancelled.
      expect(pushQueue.add).not.toHaveBeenCalled();
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'scheduled',
          scheduledAt: new Date(future),
        }),
      );
    });

    it('sends immediately when no time is given', async () => {
      arrange();

      const log = await service.send(baseDto, REQUESTER);

      expect(log.status).toBe('queued');
      expect(pushQueue.add).toHaveBeenCalled();
      expect(logRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'queued', scheduledAt: null }),
      );
    });

    it('treats a time in the past as now rather than rejecting it', async () => {
      arrange();
      const past = new Date(Date.now() - 30 * 1000).toISOString();

      const log = await service.send({ ...baseDto, scheduledAt: past }, REQUESTER);

      // A few seconds of clock skew between browser and server should not
      // turn a send into an error.
      expect(log.status).toBe('queued');
      expect(pushQueue.add).toHaveBeenCalled();
    });
  });

  describe('cancelScheduled', () => {
    it('cancels a campaign that has not been dispatched', async () => {
      logRepo.findOne.mockResolvedValueOnce({
        id: 'log-1',
        projectId: 'proj-1',
        status: 'scheduled',
      });
      logRepo.save.mockImplementation(async (o) => o);

      const log = await service.cancelScheduled('proj-1', 'log-1', REQUESTER);

      expect(log.status).toBe('cancelled');
      expect(log.completedAt).toBeInstanceOf(Date);
      expect(activity.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'campaign.cancelled', actor: { kind: 'user', userId: 'user-1' } }),
        REQUESTER.context,
        expect.anything(),
      );
    });

    it('refuses to cancel a campaign already in flight', async () => {
      logRepo.findOne.mockResolvedValueOnce({
        id: 'log-1',
        projectId: 'proj-1',
        status: 'sending',
      });

      // Stopping a running campaign needs cooperative cancellation in the
      // worker, which is a different feature from "I picked the wrong time".
      await expect(
        service.cancelScheduled('proj-1', 'log-1', REQUESTER),
      ).rejects.toThrow(/Only a scheduled campaign/);
      expect(logRepo.save).not.toHaveBeenCalled();
    });

    it('refuses a campaign belonging to another project', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.cancelScheduled('proj-1', 'log-x', REQUESTER),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('sendToUser', () => {
    const dto = {
      projectId: 'proj-1',
      distinctId: 'user-1',
      title: 'Hey',
      body: 'There',
    };

    it('throws NotFoundException when no identities match the distinctId', async () => {
      identityService.findByDistinctId.mockResolvedValueOnce([]);

      await expect(service.sendToUser(dto, REQUESTER)).rejects.toThrow(NotFoundException);
    });

    it('creates one campaign for the resolved deviceIdentityIds, logged against the person only', async () => {
      identityService.findByDistinctId.mockResolvedValueOnce([
        { id: 'dev-a', lastSeenAt: new Date('2026-01-01') },
        { id: 'dev-b', lastSeenAt: new Date('2026-02-01') },
      ]);
      const createSpy = jest
        .spyOn(service as never as { createCampaign: (...args: unknown[]) => unknown }, 'createCampaign')
        .mockResolvedValueOnce({ id: 'log-1' } as never);

      const result = await service.sendToUser(dto, REQUESTER);

      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          title: 'Hey',
          body: 'There',
          deviceIdentityIds: ['dev-a', 'dev-b'],
        }),
        expect.objectContaining({ requester: REQUESTER }),
      );
      // The most recently seen device row names the person; the distinct id never appears.
      const logging = createSpy.mock.calls[0][1] as { entry: (saved: unknown) => unknown };
      const entry = logging.entry({ id: 'log-1', projectId: 'proj-1' });
      expect(entry).toEqual({
        projectId: 'proj-1',
        action: 'push.sent_to_person',
        target: { type: 'person', id: 'dev-b', label: null },
      });
      expect(JSON.stringify(entry)).not.toContain('user-1');
      expect(result).toEqual({ id: 'log-1' });
    });
  });

  // ---------------------------------------------------------------------------
  // getLogs
  // ---------------------------------------------------------------------------
  describe('getCampaign', () => {
    it('returns one campaign with its engagement', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'log-1', projectId: 'proj-1' });
      pushAnalytics.getEngagementFor.mockResolvedValueOnce(
        new Map([
          [
            'log-1',
            {
              campaignId: 'log-1',
              delivered: 8,
              impressions: 0,
              clicks: 2,
              dismissed: 0,
              clickThroughRate: 25,
            },
          ],
        ]),
      );

      const result = await service.getCampaign('proj-1', 'log-1');

      expect(result.engagement.clickThroughRate).toBe(25);
    });

    it('is project-scoped so one tenant cannot read another campaign', async () => {
      logRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getCampaign('proj-1', 'log-x')).rejects.toThrow(
        NotFoundException,
      );
      expect(logRepo.findOne).toHaveBeenCalledWith({
        where: { id: 'log-x', projectId: 'proj-1' },
      });
    });

    it('reports null CTR rather than zero when nothing was reported', async () => {
      logRepo.findOne.mockResolvedValueOnce({ id: 'log-1', projectId: 'proj-1' });
      pushAnalytics.getEngagementFor.mockResolvedValueOnce(new Map());

      const result = await service.getCampaign('proj-1', 'log-1');

      expect(result.engagement.clickThroughRate).toBeNull();
      expect(result.engagement.delivered).toBe(0);
    });
  });

  describe('getLogs', () => {
    it('narrows to one channel when asked', async () => {
      logRepo.findAndCount.mockResolvedValueOnce([[], 0]);
      await service.getLogs('proj-1', 50, 0, 'email');
      expect(logRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: 'proj-1', channel: 'email' } }),
      );
    });

    it('returns paginated data and total', async () => {
      logRepo.findAndCount.mockResolvedValueOnce([[{ id: 'l1' }, { id: 'l2' }], 5]);

      const result = await service.getLogs('proj-1', 2, 10);

      // Each row now carries its engagement rollup, so the list can show CTR
      // without issuing a query per row.
      expect(result.total).toBe(5);
      expect(result.data.map((l) => l.id)).toEqual(['l1', 'l2']);
      expect(result.data[0].engagement).toEqual({
        campaignId: 'l1',
        delivered: 0,
        impressions: 0,
        clicks: 0,
        dismissed: 0,
        bounced: 0,
        complained: 0,
        clickThroughRate: null,
      });
      expect(logRepo.findAndCount).toHaveBeenCalledWith({
        where: { projectId: 'proj-1' },
        order: { sentAt: 'DESC' },
        take: 2,
        skip: 10,
      });
      // One aggregate for the page. This list polls every 3s while a campaign
      // is in flight, so a per-row count would multiply that load by the page
      // size.
      expect(pushAnalytics.getEngagementFor).toHaveBeenCalledTimes(1);
      expect(pushAnalytics.getEngagementFor).toHaveBeenCalledWith(['l1', 'l2']);
    });

    it('applies default limit/offset when not provided', async () => {
      logRepo.findAndCount.mockResolvedValueOnce([[], 0]);

      await service.getLogs('proj-1');

      expect(logRepo.findAndCount).toHaveBeenCalledWith(
        expect.objectContaining({ take: 50, skip: 0 }),
      );
    });
  });
});
