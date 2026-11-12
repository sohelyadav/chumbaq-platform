import { CAMPAIGN_STOPPED_BY_SUSPENSION } from '../../modules/projects/project-suspension.service';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import { PushCampaignProcessor } from './push-campaign.processor';
import { PushNotificationLogEntity } from '../../modules/push-notifications/entities/push-notification-log.entity';
import { PushConfigEntity } from '../../modules/push-notifications/entities/push-config.entity';
import { ChannelProviderRegistry } from '../../modules/push-notifications/services/channel-provider.registry';
import { ChannelCredentialsService } from '../../modules/push-notifications/channel-credentials.service';
import { PushCampaignStateService } from '../../modules/push-notifications/push-campaign-state.service';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { IdentityService } from '../../modules/identity/identity.service';
import { FcmProvider } from '../../modules/push-notifications/services/fcm.provider';
import { PushTokensService } from '../../modules/push-tokens/push-tokens.service';
import { PushCampaignJobData } from '../queue.constants';

import { EmailDeliveryService } from '../../modules/email/email-delivery.service';
import { SmsDeliveryService } from '../../modules/sms/sms-delivery.service';
import { WhatsAppDeliveryService } from '../../modules/whatsapp/whatsapp-delivery.service';

const emailDelivery = { deliver: jest.fn().mockResolvedValue(undefined) };
const smsDelivery = { deliver: jest.fn().mockResolvedValue(undefined) };
const whatsappDelivery = { deliver: jest.fn().mockResolvedValue(undefined) };

describe('PushCampaignProcessor', () => {
  let processor: PushCampaignProcessor;

  const logRepo = { findOne: jest.fn() };
  const configRepo = { findOne: jest.fn() };

  const state = {
    markSending: jest.fn(),
    recordBatch: jest.fn(),
    recordSentRecipients: jest.fn(),
    finalize: jest.fn(),
    markFailed: jest.fn(),
  };

  const cryptoService = { encrypt: jest.fn(), decrypt: jest.fn() };
  const fcmProvider = { send: jest.fn(), sendToRecipients: jest.fn() };
  // Only consulted for campaigns whose copy contains {{tokens}}.
  const identityService = { findByIds: jest.fn().mockResolvedValue([]) };

  /**
   * Builds an FcmSendResult. `resolvedCount` defaults to "the whole page
   * reached a final outcome", which is the case every test here cares about
   * except the ones that explicitly exercise a short page.
   */
  const fcmResult = (partial: {
    successCount: number;
    failureCount: number;
    failures?: Array<{ token: string; error: string; errorCode?: string }>;
    resolvedCount?: number;
    retryReason?: string | null;
  }) => ({
    successCount: partial.successCount,
    failureCount: partial.failureCount,
    failures: (partial.failures ?? []).map((f) => ({ ...f, retryable: false })),
    resolvedCount:
      partial.resolvedCount ?? partial.successCount + partial.failureCount,
    retryReason: partial.retryReason ?? null,
  });
  const channelCredentials = {
    getPlaintext: jest.fn(),
    // Every channel is deliverable unless a test says otherwise; these tests
    // are about delivery, not about which channels a project has set up.
    configuredPushProviders: jest.fn().mockResolvedValue(['fcm', 'apns', 'mi_push']),
  };

  // The worker resolves a channel to its provider now. Returning fcmProvider
  // for every channel keeps these tests about delivery rather than routing;
  // routing has its own tests.
  const channelRegistry = {
    get: jest.fn(() => fcmProvider),
    supports: jest.fn(() => true),
    supported: jest.fn(() => ['fcm']),
  };

  const pushTokensService = {
    getActiveTokensPage: jest.fn(),
    getTokensByDeviceIdentityIdsPage: jest.fn(),
    markTokensInvalid: jest.fn(),
  };

  const credentials = {
    project_id: 'fcm-proj',
    private_key: 'pk',
    client_email: 'sa@x.iam.gserviceaccount.com',
  };

  const activeConfig = {
    fcmCredentialsEncrypted: 'ct',
    fcmCredentialsIv: 'iv',
    fcmCredentialsTag: 'tag',
    isActive: true,
  };

  const makeJob = (data: PushCampaignJobData) =>
    ({ data, updateProgress: jest.fn() }) as unknown as Job<PushCampaignJobData>;

  const queuedLog = {
    id: 'log-1',
    projectId: 'proj-1',
    title: 'Hello',
    body: 'World',
    data: null,
    imageUrl: null,
    status: 'queued',
    targetType: 'project',
    targetDeviceIds: null,
    totalTokens: 3,
    processedTokens: 0,
    lastTokenId: null,
  };

  /** Behaves like the real check: true once the tenant has been suspended. */
  let tenantSuspended = false;
  const suspension = {
    isSuspended: jest.fn(async (_projectId: string) => tenantSuspended),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    tenantSuspended = false;
    cryptoService.decrypt.mockReturnValue(JSON.stringify(credentials));
    // The worker reads credentials through the channel store now; same
    // fixture, so what the provider is handed does not change.
    channelCredentials.getPlaintext.mockResolvedValue(
      JSON.stringify(credentials),
    );
    state.finalize.mockResolvedValue('sent');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        PushCampaignProcessor,
        { provide: getRepositoryToken(PushNotificationLogEntity), useValue: logRepo },
        { provide: getRepositoryToken(PushConfigEntity), useValue: configRepo },
        { provide: PushCampaignStateService, useValue: state },
        { provide: CredentialsCryptoService, useValue: cryptoService },
        { provide: FcmProvider, useValue: fcmProvider },
        { provide: ChannelCredentialsService, useValue: channelCredentials },
        { provide: ChannelProviderRegistry, useValue: channelRegistry },
        { provide: IdentityService, useValue: identityService },
        { provide: PushTokensService, useValue: pushTokensService },
        { provide: EmailDeliveryService, useValue: emailDelivery },
        { provide: SmsDeliveryService, useValue: smsDelivery },
        { provide: WhatsAppDeliveryService, useValue: whatsappDelivery },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    processor = module.get<PushCampaignProcessor>(PushCampaignProcessor);
  });

  it('is a no-op for an already-terminal campaign (redelivered job)', async () => {
    logRepo.findOne.mockResolvedValueOnce({ ...queuedLog, status: 'sent' });

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(state.markSending).not.toHaveBeenCalled();
    expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it('hands an email campaign to email delivery without requiring push setup', async () => {
    // An email-only project has no push config and no push credentials; the
    // push path would fail it on both. It must never get that far.
    const emailLog = { ...queuedLog, channel: 'email', emailContent: { subject: 'Hi', html: '<p>Hi</p>' } };
    logRepo.findOne.mockResolvedValueOnce(emailLog);
    const job = makeJob({ logId: 'log-1', projectId: 'proj-1' });

    await processor.process(job);

    expect(emailDelivery.deliver).toHaveBeenCalledWith(job, emailLog);
    expect(configRepo.findOne).not.toHaveBeenCalled();
    expect(state.markFailed).not.toHaveBeenCalled();
    expect(channelCredentials.configuredPushProviders).not.toHaveBeenCalled();
    expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
  });

  it('hands an SMS campaign to SMS delivery, not email or push', async () => {
    const smsLog = { ...queuedLog, channel: 'sms', body: 'Sale today' };
    logRepo.findOne.mockResolvedValueOnce(smsLog);
    const job = makeJob({ logId: 'log-1', projectId: 'proj-1' });

    await processor.process(job);

    expect(smsDelivery.deliver).toHaveBeenCalledWith(job, smsLog);
    expect(emailDelivery.deliver).not.toHaveBeenCalled();
    expect(configRepo.findOne).not.toHaveBeenCalled();
    expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
  });

  it('hands a WhatsApp campaign to WhatsApp delivery', async () => {
    const waLog = { ...queuedLog, channel: 'whatsapp', whatsappContent: { template: { id: 't' } } };
    logRepo.findOne.mockResolvedValueOnce(waLog);
    const job = makeJob({ logId: 'log-1', projectId: 'proj-1' });

    await processor.process(job);

    expect(whatsappDelivery.deliver).toHaveBeenCalledWith(job, waLog);
    expect(smsDelivery.deliver).not.toHaveBeenCalled();
    expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
  });

  it('does not hand a terminal email campaign to delivery again', async () => {
    logRepo.findOne.mockResolvedValueOnce({ ...queuedLog, channel: 'email', status: 'sent' });
    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));
    expect(emailDelivery.deliver).not.toHaveBeenCalled();
  });

  it('marks the campaign failed and does not retry when config is gone', async () => {
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(null);

    await expect(
      processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
    ).rejects.toThrow(/No active push config/);

    expect(state.markFailed).toHaveBeenCalledWith(
      'log-1',
      'Push configuration missing or inactive',
    );
    expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
  });

  it('fails with the real reason when the project has no configured channel', async () => {
    // Observed live: a project with 26 active FCM tokens and no credentials.
    // Nothing is selectable, so the token walk ends on an empty first page and
    // the campaign was reported as having run out of tokens — pointing the
    // operator at the one thing that was fine. Fail here, where the cause is
    // still known, and name Settings as the fix.
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    channelCredentials.configuredPushProviders.mockResolvedValueOnce([]);

    await expect(
      processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
    ).rejects.toThrow(/No configured push channel/);

    const [loggedId, message] = state.markFailed.mock.calls[0];
    expect(loggedId).toBe('log-1');
    expect(message).toMatch(/No push channel is configured/);
    expect(message).toMatch(/Settings/);

    // Never claims to be sending, and never walks the tokens.
    expect(state.markSending).not.toHaveBeenCalled();
    expect(pushTokensService.getActiveTokensPage).not.toHaveBeenCalled();
    expect(state.finalize).not.toHaveBeenCalled();
  });

  it('sends a page, checkpoints the cursor, and finalizes', async () => {
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
      ])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({ successCount: 2, failureCount: 0 }),
    );

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(state.markSending).toHaveBeenCalledWith('log-1');
    const uniformMessage = {
      title: 'Hello',
      body: 'World',
      data: undefined,
      imageUrl: undefined,
      // Rides along so the device can report delivery and clicks back against
      // this campaign. Drop it and every campaign's CTR is permanently null.
      campaignId: 'log-1',
      deepLinkUrl: undefined,
      silent: undefined,
      options: undefined,
    };
    expect(fcmProvider.sendToRecipients).toHaveBeenCalledWith(credentials, [
      { token: 't1', message: uniformMessage },
      { token: 't2', message: uniformMessage },
    ]);
    // Copy without {{tokens}} must not pay for an identity lookup.
    expect(identityService.findByIds).not.toHaveBeenCalled();
    expect(state.recordBatch).toHaveBeenCalledWith('log-1', {
      successCount: 2,
      failureCount: 0,
      failures: [],
      lastTokenId: 'tok-2',
      processedInBatch: 2,
    });
    expect(state.finalize).toHaveBeenCalledWith('log-1');
  });

  it('resumes from the persisted cursor instead of restarting', async () => {
    logRepo.findOne.mockResolvedValueOnce({
      ...queuedLog,
      status: 'sending',
      processedTokens: 500,
      lastTokenId: 'tok-500',
    });
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage.mockResolvedValueOnce([]);

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(pushTokensService.getActiveTokensPage).toHaveBeenCalledWith(
      'proj-1',
      'tok-500',
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
  });

  it('advances the cursor across multiple pages within a single job', async () => {
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
      ])
      .mockResolvedValueOnce([
        { id: 'tok-3', token: 't3' },
        { id: 'tok-4', token: 't4' },
      ])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients
      .mockResolvedValueOnce(fcmResult({ successCount: 2, failureCount: 0 }))
      .mockResolvedValueOnce(fcmResult({ successCount: 2, failureCount: 0 }));

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    // A stale cursor (e.g. always seeking from the initial checkpoint, or
    // from the wrong page) would still satisfy every other test in this
    // file but would fail these three assertions.
    expect(pushTokensService.getActiveTokensPage).toHaveBeenNthCalledWith(
      1,
      'proj-1',
      null,
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    expect(pushTokensService.getActiveTokensPage).toHaveBeenNthCalledWith(
      2,
      'proj-1',
      'tok-2',
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    expect(pushTokensService.getActiveTokensPage).toHaveBeenNthCalledWith(
      3,
      'proj-1',
      'tok-4',
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    expect(state.recordBatch).toHaveBeenNthCalledWith(
      1,
      'log-1',
      expect.objectContaining({ lastTokenId: 'tok-2' }),
    );
    expect(state.recordBatch).toHaveBeenNthCalledWith(
      2,
      'log-1',
      expect.objectContaining({ lastTokenId: 'tok-4' }),
    );
  });

  it('walks device-targeted campaigns through the identity-scoped page reader', async () => {
    logRepo.findOne.mockResolvedValueOnce({
      ...queuedLog,
      targetType: 'devices',
      targetDeviceIds: ['dev-1', 'dev-2'],
    });
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getTokensByDeviceIdentityIdsPage.mockResolvedValueOnce([]);

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(pushTokensService.getTokensByDeviceIdentityIdsPage).toHaveBeenCalledWith(
      'proj-1',
      ['dev-1', 'dev-2'],
      null,
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    expect(pushTokensService.getActiveTokensPage).not.toHaveBeenCalled();
  });

  it('walks segment-targeted campaigns through the identity-scoped page reader', async () => {
    // The whole point of this case: a segment resolves to a device id list at
    // enqueue time exactly like an explicit device target. A reader that only
    // recognises targetType 'devices' sends a 2-person segment to every active
    // token in the project instead.
    logRepo.findOne.mockResolvedValueOnce({
      ...queuedLog,
      targetType: 'segment',
      segmentId: 'seg-1',
      targetDeviceIds: ['dev-7', 'dev-8'],
    });
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getTokensByDeviceIdentityIdsPage
      .mockResolvedValueOnce([{ id: 'tok-7', token: 't7' }])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({ successCount: 1, failureCount: 0 }),
    );

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(pushTokensService.getTokensByDeviceIdentityIdsPage).toHaveBeenNthCalledWith(
      1,
      'proj-1',
      ['dev-7', 'dev-8'],
      null,
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    // Paging must stay on the identity-scoped reader for every page, not just
    // the first.
    expect(pushTokensService.getTokensByDeviceIdentityIdsPage).toHaveBeenNthCalledWith(
      2,
      'proj-1',
      ['dev-7', 'dev-8'],
      'tok-7',
      500,
      null,
      'log-1',
      ['fcm', 'apns', 'mi_push'],
    );
    expect(pushTokensService.getActiveTokensPage).not.toHaveBeenCalled();
    expect(fcmProvider.sendToRecipients).toHaveBeenCalledWith(
      credentials,
      [{ token: 't7', message: expect.anything() }],
    );
  });

  it('invalidates unregistered tokens in one project-scoped call, leaving transient failures alone', async () => {
    // The log row owns the project, not the job payload — pinned by giving the
    // two different values.
    logRepo.findOne.mockResolvedValueOnce({ ...queuedLog, projectId: 'proj-log' });
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
        { id: 'tok-3', token: 't3' },
        { id: 'tok-4', token: 't4' },
      ])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({
        successCount: 1,
        failureCount: 3,
        failures: [
          { token: 't2', error: 'FCM error 404: ...', errorCode: 'NOT_FOUND' },
          {
            token: 't3',
            error: 'FCM error 400: ...',
            errorCode: 'INVALID_ARGUMENT',
          },
          {
            token: 't4',
            error: 'FCM error 404: ...',
            errorCode: 'UNREGISTERED',
          },
        ],
      }),
    );

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-job' }));

    // One batched UPDATE for the whole page, not one awaited call per failure.
    expect(pushTokensService.markTokensInvalid).toHaveBeenCalledTimes(1);
    expect(pushTokensService.markTokensInvalid).toHaveBeenCalledWith('proj-log', [
      't2',
      't4',
    ]);
  });

  it('does not touch token state when a batch reports no unregistered tokens', async () => {
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([{ id: 'tok-1', token: 't1' }])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({
        successCount: 0,
        failureCount: 1,
        failures: [
          {
            token: 't1',
            error: 'FCM error 400: ...',
            errorCode: 'INVALID_ARGUMENT',
          },
        ],
      }),
    );

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    expect(pushTokensService.markTokensInvalid).not.toHaveBeenCalled();
  });

  it('reports progress against the campaign total', async () => {
    logRepo.findOne.mockResolvedValueOnce({ ...queuedLog, totalTokens: 4 });
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
      ])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({ successCount: 2, failureCount: 0 }),
    );

    const job = makeJob({ logId: 'log-1', projectId: 'proj-1' });
    await processor.process(job);

    expect(job.updateProgress).toHaveBeenCalledWith(50);
  });

  describe('when FCM is still failing at the end of a page', () => {
    it('checkpoints only the resolved prefix and fails the attempt', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage.mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
        { id: 'tok-3', token: 't3' },
      ]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({
          successCount: 1,
          failureCount: 0,
          resolvedCount: 1,
          retryReason: 'FCM error 429: slow down',
        }),
      );

      await expect(
        processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
      ).rejects.toThrow(/429/);

      // tok-2 is unresolved, so the cursor stops at tok-1. Advancing it to
      // tok-3 — which is what recording the whole page would do — would leave
      // tok-2 and tok-3 permanently unreachable on the next attempt.
      expect(state.recordBatch).toHaveBeenCalledWith(
        'log-1',
        expect.objectContaining({
          lastTokenId: 'tok-1',
          processedInBatch: 1,
          successCount: 1,
        }),
      );
      // Throwing hands the wait to BullMQ's backoff; the campaign is not over.
      expect(state.finalize).not.toHaveBeenCalled();
    });

    it('writes no checkpoint at all when the first token of the page is unresolved', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage.mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
      ]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({
          successCount: 0,
          failureCount: 0,
          resolvedCount: 0,
          retryReason: 'FCM error 503: unavailable',
        }),
      );

      await expect(
        processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
      ).rejects.toThrow(/503/);

      // Nothing was resolved, so the persisted cursor must not move — the
      // retry has to re-read this page from exactly where it started.
      expect(state.recordBatch).not.toHaveBeenCalled();
      expect(state.finalize).not.toHaveBeenCalled();
    });

    it('still deactivates unregistered tokens found in the resolved prefix', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage.mockResolvedValueOnce([
        { id: 'tok-1', token: 't1' },
        { id: 'tok-2', token: 't2' },
      ]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({
          successCount: 0,
          failureCount: 1,
          failures: [
            {
              token: 't1',
              error: 'FCM error 404: ...',
              errorCode: 'UNREGISTERED',
            },
          ],
          resolvedCount: 1,
          retryReason: 'FCM error 429: slow down',
        }),
      );

      await expect(
        processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
      ).rejects.toThrow(/429/);

      // A dead token stays dead regardless of why the page stopped short;
      // leaving it active would have it retried on every future campaign.
      expect(pushTokensService.markTokensInvalid).toHaveBeenCalledWith(
        'proj-1',
        ['t1'],
      );
    });
  });

  it('persists the FCM error code, not just the raw response body', async () => {
    logRepo.findOne.mockResolvedValueOnce(queuedLog);
    configRepo.findOne.mockResolvedValueOnce(activeConfig);
    pushTokensService.getActiveTokensPage
      .mockResolvedValueOnce([{ id: 'tok-1', token: 't1' }])
      .mockResolvedValueOnce([]);
    fcmProvider.sendToRecipients.mockResolvedValueOnce(
      fcmResult({
        successCount: 0,
        failureCount: 1,
        failures: [
          {
            token: 't1',
            error: 'FCM error 404: {"error":{"status":"NOT_FOUND"}}',
            errorCode: 'UNREGISTERED',
          },
        ],
      }),
    );

    await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

    // Without this the only record is FCM's raw HTTP envelope, and every
    // reader has to re-parse it to say anything legible about the failure.
    expect(state.recordBatch).toHaveBeenCalledWith(
      'log-1',
      expect.objectContaining({
        failures: [
          expect.objectContaining({ token: 't1', errorCode: 'UNREGISTERED' }),
        ],
      }),
    );
  });

  describe('channel routing', () => {
    it('sends each token through the provider for its channel', async () => {
      const page = [
        { id: 't1', token: 'tok-1', deviceIdentityId: 'd1', provider: 'fcm' },
      ];
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(channelRegistry.get).toHaveBeenCalledWith('fcm');
    });

    it('stops a page at a channel boundary rather than mixing channels', async () => {
      // resolvedCount describes a prefix and the cursor advances through it.
      // Across two channels there is no single prefix, so the run stops at the
      // boundary and the next iteration picks the other channel up.
      const page = [
        { id: 't1', token: 'mi-1', deviceIdentityId: 'd1', provider: 'mi_push' },
        { id: 't2', token: 'mi-2', deviceIdentityId: 'd2', provider: 'mi_push' },
        { id: 't3', token: 'fcm-1', deviceIdentityId: 'd3', provider: 'fcm' },
      ];
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce(page)
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 2, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(channelRegistry.get).toHaveBeenCalledWith('mi_push');
      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients.map((r: { token: string }) => r.token)).toEqual([
        'mi-1',
        'mi-2',
      ]);
    });
  });

  describe('countdowns', () => {
    const withTimer = (timer: unknown) => ({ ...queuedLog, timer });

    it('resolves a relative countdown against this send', async () => {
      logRepo.findOne.mockResolvedValueOnce(withTimer({ durationSeconds: 3600 }));
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 't1', token: 'tok-1', deviceIdentityId: 'd1', provider: 'fcm' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      const before = Date.now();
      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // Each recurring occurrence and each timezone wave is its own send, so
      // resolving here is what stops the later ones inheriting a deadline that
      // has already passed.
      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      const endsAt = Date.parse(recipients[0].message.timer.endsAt);
      expect(endsAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(endsAt).toBeLessThan(before + 3600 * 1000 + 60_000);
    });

    it('leaves a fixed deadline alone', async () => {
      logRepo.findOne.mockResolvedValueOnce(
        withTimer({ endsAt: '2099-01-01T00:00:00.000Z' }),
      );
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 't1', token: 'tok-1', deviceIdentityId: 'd1', provider: 'fcm' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // A real deadline is the same moment for everyone, which is the reason
      // to have chosen one over a duration.
      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.timer.endsAt).toBe('2099-01-01T00:00:00.000Z');
    });

    it('sends without a countdown when the campaign carries none', async () => {
      logRepo.findOne.mockResolvedValueOnce(withTimer(null));
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 't1', token: 'tok-1', deviceIdentityId: 'd1', provider: 'fcm' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.timer).toBeUndefined();
    });
  });

  describe('per-channel credentials', () => {
    it('reads credentials for the channel it is about to send on', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([
          { id: 't1', token: 'mi-1', deviceIdentityId: 'd1', provider: 'mi_push' },
        ])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // Loading one channel's credentials up front is how a Mi Push send ends
      // up handed a Firebase service account.
      expect(channelCredentials.getPlaintext).toHaveBeenCalledWith(
        'proj-1',
        'mi_push',
      );
    });

    it('fails the campaign when the channel has no credentials', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage.mockResolvedValueOnce([
        { id: 't1', token: 'mi-1', deviceIdentityId: 'd1', provider: 'mi_push' },
      ]);
      channelCredentials.getPlaintext.mockResolvedValueOnce(null);

      // Tokens exist for the channel, so recipients are waiting on it.
      // Reporting success while sending nothing would hide the missing
      // configuration behind a campaign that looks delivered.
      await expect(
        processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' })),
      ).rejects.toThrow();
      expect(state.markFailed).toHaveBeenCalledWith(
        'log-1',
        expect.stringContaining('mi_push'),
      );
      expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
    });
  });

  describe('delivery throttling', () => {
    const arrange = (maxSendsPerMinute: number | null) => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce({
        ...activeConfig,
        maxSendsPerMinute,
      });
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );
    };

    it('does not pause when no rate is configured', async () => {
      arrange(null);
      const started = Date.now();

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(Date.now() - started).toBeLessThan(200);
    });

    it('paces a page to stay under the configured rate', async () => {
      // 60/min means one message per second, so a one-message page waits ~1s.
      arrange(60);
      const started = Date.now();

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const elapsed = Date.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(900);
      expect(elapsed).toBeLessThan(3000);
    });

    it('caps the wait so a low rate cannot park the worker', async () => {
      // 1/min would ideally wait a full minute for one message. BullMQ would
      // reclaim the job as stalled long before that, so the wait is bounded.
      arrange(1);
      const started = Date.now();

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(Date.now() - started).toBeLessThan(35_000);
    }, 40_000);
  });

  describe('multi-language copy', () => {
    const translatedLog = {
      ...queuedLog,
      title: 'Default title',
      body: 'Default body',
      translations: {
        hi: { title: 'हिंदी शीर्षक', body: 'हिंदी' },
        'pt-BR': { title: 'Olá Brasil' },
      },
    };

    const arrange = () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([
          { id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' },
          { id: 'tok-2', token: 't2', deviceIdentityId: 'id-2' },
          { id: 'tok-3', token: 't3', deviceIdentityId: 'id-3' },
        ])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 3, failureCount: 0 }),
      );
    };

    it('sends each recipient their own language', async () => {
      logRepo.findOne.mockResolvedValueOnce(translatedLog);
      arrange();
      identityService.findByIds.mockResolvedValueOnce([
        { id: 'id-1', language: 'hi' },
        { id: 'id-2', language: 'pt-BR' },
        { id: 'id-3', language: 'ja' },
      ]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.title).toBe('हिंदी शीर्षक');
      expect(recipients[1].message.title).toBe('Olá Brasil');
      // Japanese has no translation, so the campaign's own copy is used —
      // an untranslated language must still receive the campaign.
      expect(recipients[2].message.title).toBe('Default title');
    });

    it('keeps the default body when a translation only overrides the title', async () => {
      logRepo.findOne.mockResolvedValueOnce(translatedLog);
      arrange();
      identityService.findByIds.mockResolvedValueOnce([
        { id: 'id-1', language: 'pt-BR' },
        { id: 'id-2', language: 'pt-BR' },
        { id: 'id-3', language: 'pt-BR' },
      ]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.title).toBe('Olá Brasil');
      expect(recipients[0].message.body).toBe('Default body');
    });

    it('personalises the translated copy, not the default', async () => {
      logRepo.findOne.mockResolvedValueOnce({
        ...queuedLog,
        title: 'Hi {{firstName}}',
        body: null,
        translations: { hi: { title: 'नमस्ते {{firstName}}' } },
      });
      arrange();
      identityService.findByIds.mockResolvedValueOnce([
        { id: 'id-1', language: 'hi', firstName: 'Priya' },
        { id: 'id-2', language: 'en', firstName: 'Alex' },
        { id: 'id-3', language: 'hi', firstName: 'Arjun' },
      ]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      // Translate first, then substitute — the other order would fill in the
      // default string and then throw it away.
      expect(recipients[0].message.title).toBe('नमस्ते Priya');
      expect(recipients[1].message.title).toBe('Hi Alex');
    });

    it('does not fetch identities for a campaign with neither feature', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      arrange();

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(identityService.findByIds).not.toHaveBeenCalled();
    });
  });

  describe('frequency capping', () => {
    it('passes the project cap and campaign id to the page reader', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce({
        ...activeConfig,
        frequencyCapPerDay: 2,
      });
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(pushTokensService.getActiveTokensPage).toHaveBeenCalledWith(
        'proj-1',
        null,
        500,
        2,
        // Its own id, so a resumed walk does not start capping against itself.
        'log-1',
      ['fcm', 'apns', 'mi_push'],
      );
    });

    it('records who was sent to, so the next campaign can count it', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce({
        ...activeConfig,
        frequencyCapPerDay: 3,
      });
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([
          { id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' },
          { id: 'tok-2', token: 't2', deviceIdentityId: 'id-2' },
        ])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 2, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      expect(state.recordSentRecipients).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'log-1' }),
        ['id-1', 'id-2'],
      );
    });

    it('does not count a device FCM refused against its budget', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce({
        ...activeConfig,
        frequencyCapPerDay: 3,
      });
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([
          { id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' },
          { id: 'tok-2', token: 't2', deviceIdentityId: 'id-2' },
        ])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({
          successCount: 1,
          failureCount: 1,
          failures: [
            { token: 't2', error: 'FCM error 404: ...', errorCode: 'UNREGISTERED' },
          ],
        }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // Nobody received anything on t2, so spending a slot of that person's
      // daily budget would suppress a later campaign for no reason.
      expect(state.recordSentRecipients).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'log-1' }),
        ['id-1'],
      );
    });

    it('writes no per-recipient rows when the project is uncapped', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([{ id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' }])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 1, failureCount: 0 }),
      );

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // One row per recipient per campaign is real volume; a project that does
      // not cap should not pay for it.
      expect(state.recordSentRecipients).not.toHaveBeenCalled();
    });
  });

  describe('personalised copy', () => {
    const personalisedLog = {
      ...queuedLog,
      title: 'Hi {{firstName|there}}',
      body: 'Your {{trait.plan}} plan is ready',
    };

    const arrange = () => {
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([
          { id: 'tok-1', token: 't1', deviceIdentityId: 'id-1' },
          { id: 'tok-2', token: 't2', deviceIdentityId: 'id-2' },
        ])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients.mockResolvedValueOnce(
        fcmResult({ successCount: 2, failureCount: 0 }),
      );
    };

    it('renders a different message per recipient', async () => {
      logRepo.findOne.mockResolvedValueOnce(personalisedLog);
      arrange();
      identityService.findByIds.mockResolvedValueOnce([
        { id: 'id-1', firstName: 'Priya', traits: { plan: 'gold' } },
        { id: 'id-2', firstName: 'Arjun', traits: { plan: 'silver' } },
      ]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.title).toBe('Hi Priya');
      expect(recipients[1].message.title).toBe('Hi Arjun');
      expect(recipients[0].message.body).toBe('Your gold plan is ready');
      expect(recipients[1].message.body).toBe('Your silver plan is ready');
    });

    it('resolves the whole page in one query, not one per token', async () => {
      logRepo.findOne.mockResolvedValueOnce(personalisedLog);
      arrange();
      identityService.findByIds.mockResolvedValueOnce([]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      // A page is up to 500 tokens; a lookup per token would be 500 queries
      // between every checkpoint.
      expect(identityService.findByIds).toHaveBeenCalledTimes(1);
      expect(identityService.findByIds).toHaveBeenCalledWith(['id-1', 'id-2']);
    });

    it('still sends to someone whose identity has gone, using fallbacks', async () => {
      logRepo.findOne.mockResolvedValueOnce(personalisedLog);
      arrange();
      // id-2 resolves to nothing — deleted, or merged away.
      identityService.findByIds.mockResolvedValueOnce([
        { id: 'id-1', firstName: 'Priya', traits: { plan: 'gold' } },
      ]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      // Dropping the recipient would silently shrink the audience, and the
      // campaign would report a smaller send than the user asked for.
      expect(recipients).toHaveLength(2);
      expect(recipients[1].message.title).toBe('Hi there');
    });

    it('never ships raw template syntax to a lock screen', async () => {
      logRepo.findOne.mockResolvedValueOnce({
        ...queuedLog,
        title: 'Hi {{firstName}}',
        body: null,
      });
      arrange();
      identityService.findByIds.mockResolvedValueOnce([]);

      await processor.process(makeJob({ logId: 'log-1', projectId: 'proj-1' }));

      const [, recipients] = fcmProvider.sendToRecipients.mock.calls[0];
      expect(recipients[0].message.title).not.toContain('{{');
    });
  });

  describe('onFailed', () => {
    const makeFailedJob = (attemptsMade: number, attempts: number) =>
      ({
        data: { logId: 'log-1', projectId: 'proj-1' },
        attemptsMade,
        opts: { attempts },
      }) as unknown as Job<PushCampaignJobData>;

    it('marks the campaign failed once retries are exhausted', async () => {
      const job = makeFailedJob(3, 3);

      await processor.onFailed(job, new Error('FCM error 500: unavailable'));

      expect(state.markFailed).toHaveBeenCalledTimes(1);
      const [loggedId, message] = state.markFailed.mock.calls[0];
      expect(loggedId).toBe('log-1');
      expect(message).toContain('log-1');
      expect(message).toContain('FCM error 500: unavailable');
    });

    it('does not mark the campaign failed while retries remain', async () => {
      const job = makeFailedJob(1, 3);

      await processor.onFailed(job, new Error('transient'));

      expect(state.markFailed).not.toHaveBeenCalled();
    });

    it('is a no-op when BullMQ reports no job', async () => {
      await processor.onFailed(undefined, new Error('transient'));

      expect(state.markFailed).not.toHaveBeenCalled();
    });
  });

  describe('when the tenant is suspended', () => {
    const token = (n: number) => ({
      id: `tok-${n}`,
      token: `t${n}`,
      provider: 'fcm',
      deviceIdentityId: `dev-${n}`,
    });
    const job = () => makeJob({ logId: 'log-1', projectId: 'proj-1' });
    const onePage = () => ({
      successCount: 1,
      failureCount: 0,
      failures: [],
      resolvedCount: 1,
      retryReason: null,
    });

    it.each(['push', 'email', 'sms', 'whatsapp'])(
      'does not start a queued %s campaign, and does not fail the job into a retry',
      async (channel) => {
        tenantSuspended = true;
        logRepo.findOne.mockResolvedValueOnce({ ...queuedLog, channel });

        await expect(processor.process(job())).resolves.toBeUndefined();

        expect(state.markFailed).toHaveBeenCalledWith('log-1', CAMPAIGN_STOPPED_BY_SUSPENSION);
        expect(state.markSending).not.toHaveBeenCalled();
        expect(emailDelivery.deliver).not.toHaveBeenCalled();
        expect(smsDelivery.deliver).not.toHaveBeenCalled();
        expect(whatsappDelivery.deliver).not.toHaveBeenCalled();
        expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
      },
    );

    it('stops a running push campaign at the next page', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([token(1)])
        .mockResolvedValueOnce([token(2)]);
      fcmProvider.sendToRecipients.mockImplementationOnce(async () => {
        tenantSuspended = true;
        return onePage();
      });

      await expect(processor.process(job())).resolves.toBeUndefined();

      expect(fcmProvider.sendToRecipients).toHaveBeenCalledTimes(1);
      expect(state.recordBatch).toHaveBeenCalledTimes(1);
      expect(state.markFailed).toHaveBeenCalledWith('log-1', CAMPAIGN_STOPPED_BY_SUSPENSION);
      expect(state.finalize).not.toHaveBeenCalled();
    });

    it('lets an active tenant send every page', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage
        .mockResolvedValueOnce([token(1)])
        .mockResolvedValueOnce([token(2)])
        .mockResolvedValueOnce([]);
      fcmProvider.sendToRecipients
        .mockResolvedValueOnce(onePage())
        .mockResolvedValueOnce(onePage());

      await processor.process(job());

      expect(fcmProvider.sendToRecipients).toHaveBeenCalledTimes(2);
      expect(state.markFailed).not.toHaveBeenCalled();
      expect(state.finalize).toHaveBeenCalledWith('log-1');
    });

    it('retries rather than sends when the suspension check itself fails', async () => {
      logRepo.findOne.mockResolvedValueOnce(queuedLog);
      configRepo.findOne.mockResolvedValueOnce(activeConfig);
      pushTokensService.getActiveTokensPage.mockResolvedValueOnce([token(1)]);
      suspension.isSuspended
        .mockImplementationOnce(async () => false)
        .mockImplementationOnce(async () => {
          throw new Error('connection lost');
        });

      await expect(processor.process(job())).rejects.toThrow('connection lost');

      expect(fcmProvider.sendToRecipients).not.toHaveBeenCalled();
    });
  });
});
