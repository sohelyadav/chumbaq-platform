import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { JourneyScheduler } from './journey.scheduler';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { MAX_STEPS_PER_RUN } from '../../modules/journeys/journey-definition';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { SegmentEvaluationService } from '../../modules/segments/segment-evaluation.service';
import { PushNotificationsService } from '../../modules/push-notifications/push-notifications.service';

import { EmailCampaignsService } from '../../modules/email/email-campaigns.service';
import { SmsCampaignsService } from '../../modules/sms/sms-campaigns.service';
import { WhatsAppCampaignsService } from '../../modules/whatsapp/whatsapp-campaigns.service';

const emailCampaigns = {
  countReachable: jest.fn().mockResolvedValue(1),
  send: jest.fn().mockResolvedValue({ id: 'email-1' }),
};
const smsCampaigns = {
  countReachable: jest.fn().mockResolvedValue(1),
  send: jest.fn().mockResolvedValue({ id: 'sms-1' }),
};
const whatsappCampaigns = {
  countReachable: jest.fn().mockResolvedValue(1),
  send: jest.fn().mockResolvedValue({ id: 'wa-1' }),
};

describe('JourneyScheduler', () => {
  let scheduler: JourneyScheduler;
  let qb: any;

  const journeyRepository = { find: jest.fn(), update: jest.fn() };
  const runRepository = {
    find: jest.fn(),
    update: jest.fn(),
    createQueryBuilder: jest.fn(),
    manager: { query: jest.fn() },
  };
  const segmentRepository = { findOne: jest.fn() };
  const segmentEvaluation = {
    isMember: jest.fn(),
    resolveDeviceIdentityIds: jest.fn(),
  };
  const pushNotifications = { send: jest.fn(), countReachableDevices: jest.fn() };

  let suspendedProjects = new Set<string>();
  const suspension = { suspendedProjectIds: jest.fn(async () => suspendedProjects) };

  /** Order of calls across the claim and the send, for the claim-first test. */
  let callOrder: string[];

  const WATERMARK = new Date('2026-06-15T09:00:00Z');

  const journey = (over: Record<string, unknown> = {}) => ({
    id: 'j-1',
    projectId: 'proj-1',
    status: 'active',
    trigger: { type: 'event', eventName: 'signup' },
    steps: [{ type: 'wait', durationSeconds: 3600 }, { type: 'exit' }],
    enrolledThrough: WATERMARK,
    ...over,
  });

  const run = (over: Record<string, unknown> = {}) => ({
    id: 'run-1',
    projectId: 'proj-1',
    journeyId: 'j-1',
    personKey: 'user-1',
    currentStepIndex: 0,
    stepsTaken: 0,
    status: 'active',
    nextDueAt: new Date('2026-06-15T09:00:00Z'),
    ...over,
  });

  /** The raw SQL of the nth manager.query call. */
  const sqlOf = (index: number): string =>
    runRepository.manager.query.mock.calls[index][0] as string;
  const paramsOf = (index: number): unknown[] =>
    runRepository.manager.query.mock.calls[index][1] as unknown[];

  beforeEach(async () => {
    jest.clearAllMocks();
    suspendedProjects = new Set<string>();
    callOrder = [];

    qb = {};
    for (const m of ['update', 'set', 'where', 'andWhere']) {
      qb[m] = jest.fn(() => qb);
    }
    qb.execute = jest.fn(async () => {
      callOrder.push('claim');
      return { affected: 1 };
    });
    runRepository.createQueryBuilder.mockReturnValue(qb);
    runRepository.find.mockResolvedValue([]);
    runRepository.update.mockResolvedValue({ affected: 1 });
    journeyRepository.find.mockResolvedValue([]);
    journeyRepository.update.mockResolvedValue({ affected: 1 });
    segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
    pushNotifications.countReachableDevices.mockResolvedValue(1);
    pushNotifications.send.mockImplementation(async () => {
      callOrder.push('send');
      return { id: 'log-1' };
    });

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        JourneyScheduler,
        { provide: getRepositoryToken(JourneyEntity), useValue: journeyRepository },
        { provide: getRepositoryToken(JourneyRunEntity), useValue: runRepository },
        { provide: getRepositoryToken(SegmentEntity), useValue: segmentRepository },
        { provide: SegmentEvaluationService, useValue: segmentEvaluation },
        { provide: PushNotificationsService, useValue: pushNotifications },
        { provide: EmailCampaignsService, useValue: emailCampaigns },
        { provide: SmsCampaignsService, useValue: smsCampaigns },
        { provide: WhatsAppCampaignsService, useValue: whatsappCampaigns },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    scheduler = module.get(JourneyScheduler);
  });

  describe('enrolment from an event trigger', () => {
    /** Boundary query empty (fewer than a page left), then n rows inserted. */
    const enrolsInOnePage = (inserted: number) => {
      runRepository.manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(new Array(inserted).fill({ id: 'r' }));
    };

    it('only looks at events after the journey watermark', async () => {
      journeyRepository.find.mockResolvedValue([journey()]);
      enrolsInOnePage(2);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(2);

      // Both halves of the page are bounded below by the watermark: activating
      // a journey on a mature project must not sweep up everyone who ever
      // fired the event.
      expect(paramsOf(0)[2]).toBe(WATERMARK);
      expect(paramsOf(1)[3]).toBe(WATERMARK);
      expect(sqlOf(1)).toContain('INSERT INTO journey_runs');
    });

    it('advances the watermark to the page boundary it just enrolled', async () => {
      journeyRepository.find.mockResolvedValue([journey()]);
      enrolsInOnePage(1);

      await scheduler.enrolNewPeople();

      const [criteria, update] = journeyRepository.update.mock.calls[0];
      // Conditional on the value this instance read, so a second instance
      // working the same journey cannot drag the watermark backwards.
      expect(criteria).toEqual({ id: 'j-1', enrolledThrough: WATERMARK });
      expect((update.enrolledThrough as Date).getTime()).toBeGreaterThan(
        WATERMARK.getTime(),
      );
    });

    it('pages, rather than enrolling a whole backlog in one statement', async () => {
      const boundary = new Date('2026-06-15T09:30:00Z');
      journeyRepository.find.mockResolvedValue([journey()]);
      runRepository.manager.query
        // A full page: there is more beyond this boundary.
        .mockResolvedValueOnce([{ boundary }])
        .mockResolvedValueOnce([{ id: 'r' }])
        // Second pass catches up.
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r' }]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(2);

      // The second page starts exactly where the first stopped, and takes the
      // whole tie: `> previous AND <= boundary` never cuts a shared timestamp
      // in half.
      expect(paramsOf(1)[4]).toEqual(boundary);
      expect(paramsOf(3)[3]).toEqual(boundary);
      expect(journeyRepository.update).toHaveBeenCalledTimes(2);
    });

    it('leaves the one-run-at-a-time rule to the partial unique index', async () => {
      journeyRepository.find.mockResolvedValue([journey()]);
      enrolsInOnePage(0);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(0);

      // No read-then-insert anywhere: two ticks would race the check and enrol
      // the same person twice. The conflict is tolerated instead.
      expect(runRepository.find).not.toHaveBeenCalled();
      expect(sqlOf(1)).toContain(
        "ON CONFLICT (journey_id, person_key) WHERE status = 'active' DO NOTHING",
      );
    });

    it('starts a journey with no watermark from now, enrolling nobody yet', async () => {
      journeyRepository.find.mockResolvedValue([
        journey({ enrolledThrough: null }),
      ]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(0);

      expect(runRepository.manager.query).not.toHaveBeenCalled();
      expect(journeyRepository.update).toHaveBeenCalledTimes(1);
      const [, update] = journeyRepository.update.mock.calls[0];
      expect(update.enrolledThrough).toBeInstanceOf(Date);
    });

    it('stops when another instance has already moved the watermark', async () => {
      journeyRepository.find.mockResolvedValue([journey()]);
      runRepository.manager.query
        .mockResolvedValueOnce([{ boundary: new Date('2026-06-15T09:30:00Z') }])
        .mockResolvedValueOnce([{ id: 'r' }]);
      journeyRepository.update.mockResolvedValue({ affected: 0 });

      await scheduler.enrolNewPeople();

      // Two queries, not four: the failed conditional update means the other
      // instance owns this journey's pages for the rest of the tick.
      expect(runRepository.manager.query).toHaveBeenCalledTimes(2);
    });

    it('keeps enrolling other journeys when one of them fails', async () => {
      journeyRepository.find.mockResolvedValue([
        journey({ id: 'j-broken' }),
        journey({ id: 'j-fine' }),
      ]);
      runRepository.manager.query
        .mockRejectedValueOnce(new Error('statement timeout'))
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r' }]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(1);
    });

    it('ignores a journey whose trigger is not one it knows', async () => {
      journeyRepository.find.mockResolvedValue([
        journey({ trigger: { type: 'phase_of_the_moon' } }),
      ]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(0);
      expect(runRepository.manager.query).not.toHaveBeenCalled();
    });
  });

  describe('enrolment from a segment trigger', () => {
    const segmentJourney = journey({
      trigger: { type: 'segment_entry', segmentId: 'seg-1' },
    });

    it('enrols whoever entered the segment since the watermark', async () => {
      journeyRepository.find.mockResolvedValue([
        { ...segmentJourney, enrolledThrough: new Date('2026-06-01T00:00:00Z') },
      ]);
      runRepository.manager.query
        // boundary lookup — nothing further out, so the tick's ceiling stands
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }]);
      journeyRepository.update.mockResolvedValue({ affected: 1 });

      await expect(scheduler.enrolNewPeople()).resolves.toBe(3);

      // Keyed on when they entered, not on whether they have ever run this
      // journey — which is what allows someone who left and came back to be
      // enrolled again.
      expect(sqlOf(1)).toContain('m.entered_at > $4');
      expect(sqlOf(1)).toContain('m.entered_at <= $5');
      expect(sqlOf(1)).not.toContain('NOT EXISTS');
      expect(sqlOf(1)).toContain(
        "ON CONFLICT (journey_id, person_key) WHERE status = 'active' DO NOTHING",
      );
    });

    it('bounds a page on an entry time that exists in the data', async () => {
      const watermark = new Date('2026-06-01T00:00:00Z');
      const boundary = new Date('2026-06-01T06:00:00Z');
      journeyRepository.find.mockResolvedValue([
        { ...segmentJourney, enrolledThrough: watermark },
      ]);
      runRepository.manager.query
        .mockResolvedValueOnce([{ boundary }])
        .mockResolvedValueOnce([{ id: 'r1' }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r2' }]);
      journeyRepository.update.mockResolvedValue({ affected: 1 });

      await scheduler.enrolNewPeople();

      // Read from the data rather than computed, so a moment shared by many
      // people who entered together is never cut in half.
      expect(paramsOf(1)[4]).toEqual(boundary);
      expect(journeyRepository.update).toHaveBeenCalledWith(
        { id: segmentJourney.id, enrolledThrough: watermark },
        { enrolledThrough: boundary },
      );
    });

    it('stops when another instance has already moved the watermark', async () => {
      journeyRepository.find.mockResolvedValue([
        { ...segmentJourney, enrolledThrough: new Date('2026-06-01T00:00:00Z') },
      ]);
      runRepository.manager.query
        .mockResolvedValueOnce([{ boundary: new Date('2026-06-01T06:00:00Z') }])
        .mockResolvedValueOnce([{ id: 'r1' }]);
      // The conditional update matched nothing: another instance owns this
      // journey, and re-walking would only conflict.
      journeyRepository.update.mockResolvedValue({ affected: 0 });

      await scheduler.enrolNewPeople();

      expect(runRepository.manager.query).toHaveBeenCalledTimes(2);
    });

    it('starts from now when a journey has no watermark', async () => {
      journeyRepository.find.mockResolvedValue([
        { ...segmentJourney, enrolledThrough: null },
      ]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(0);

      // Reading a null watermark as the beginning of time would enrol the
      // whole segment at once.
      expect(runRepository.manager.query).not.toHaveBeenCalled();
      expect(journeyRepository.update).toHaveBeenCalled();
    });

  });

  describe('advancing runs', () => {
    const due = (runs: Array<Record<string, unknown>>) => {
      runRepository.find.mockResolvedValue(runs);
    };

    it('selects only active runs whose time has come', async () => {
      await scheduler.advanceDueRuns();

      const options = runRepository.find.mock.calls[0][0];
      expect(options.where.status).toBe('active');
      // A completed, exited or failed run has no status 'active' and no
      // next_due_at, so it can never be picked up again.
      expect(options.where.nextDueAt).toBeDefined();
      expect(options.order).toEqual({ nextDueAt: 'ASC' });
    });

    it('treats a run due within the grace as due now', async () => {
      // The live failure: a 60-second wait decided at 00:06:00.030 came due at
      // 00:07:00.030, and the 00:07:00.000 tick found it 30ms early — so the
      // run sat on a one-minute wait for two minutes. Without a tolerance the
      // shortest wait the product allows is always the one that doubles.
      const before = Date.now();
      await scheduler.advanceDueRuns();

      const { nextDueAt } = runRepository.find.mock.calls[0][0].where;
      const cutoff = (nextDueAt.value as Date).getTime();

      // Ahead of the wall clock, by the grace rather than by a whole tick.
      expect(cutoff).toBeGreaterThanOrEqual(before + 1000);
      expect(cutoff).toBeLessThan(before + 60_000);
    });

    it('claims against the same cut-off it selected on', async () => {
      // These two must agree. A select that admits a run the claim then
      // refuses advances nothing while reporting work found — the tick spins
      // every minute, forever, and the run never moves.
      due([run()]);
      journeyRepository.find.mockResolvedValue([journey()]);

      await scheduler.advanceDueRuns();

      const selectCutoff = (
        runRepository.find.mock.calls[0][0].where.nextDueAt.value as Date
      ).getTime();
      const claimCall = qb.andWhere.mock.calls.find(
        ([clause]: [string]) => clause === 'next_due_at <= :now',
      );
      expect(claimCall).toBeDefined();
      expect((claimCall[1].now as Date).getTime()).toBe(selectCutoff);
    });

    it('measures a new wait from the real clock, not the padded cut-off', async () => {
      // The grace decides what is due; it must not also lengthen every wait by
      // five seconds, which would make it a drift rather than a tolerance.
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'wait', durationSeconds: 60 }, { type: 'exit' }] }),
      ]);

      const before = Date.now();
      await scheduler.advanceDueRuns();
      const after = Date.now();

      const { nextDueAt } = runRepository.update.mock.calls[0][1];
      const dueAt = (nextDueAt as Date).getTime();
      expect(dueAt).toBeGreaterThanOrEqual(before + 60_000);
      expect(dueAt).toBeLessThanOrEqual(after + 60_000);
    });

    it('claims a run with a conditional update before touching it', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([journey()]);

      await scheduler.advanceDueRuns();

      // Clearing next_due_at is the claim: the second instance's UPDATE
      // re-checks the row it blocked on, sees NULL, and matches nothing.
      expect(qb.set).toHaveBeenCalledWith({ nextDueAt: null });
      expect(qb.andWhere).toHaveBeenCalledWith('next_due_at IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith('status = :status', {
        status: 'active',
      });
    });

    it('does nothing at all when the claim loses the race', async () => {
      due([run({ currentStepIndex: 0 })]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_push', title: 'Hello' }] }),
      ]);
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      await expect(scheduler.advanceDueRuns()).resolves.toBe(0);

      // The instance that won the race is sending this push. Sending it here
      // as well is the same person receiving the same message twice.
      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update).not.toHaveBeenCalled();
    });

    it('reschedules a due wait and moves on to the next step', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'wait', durationSeconds: 3600 },
            { type: 'send_push', title: 'Later' },
          ],
        }),
      ]);

      const before = Date.now();
      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      const [criteria, update] = runRepository.update.mock.calls[0];
      expect(criteria).toEqual({ id: 'run-1' });
      expect(update.currentStepIndex).toBe(1);
      expect(update.stepsTaken).toBe(1);
      const dueAt = (update.nextDueAt as Date).getTime();
      expect(dueAt).toBeGreaterThanOrEqual(before + 3600 * 1000);
      expect(dueAt).toBeLessThan(before + 3600 * 1000 + 5000);
    });

    it('sends a push step as a campaign for that one person', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            {
              type: 'send_push',
              title: 'Welcome',
              body: 'Glad you are here',
              deepLinkUrl: 'https://example.com/home',
            },
            { type: 'exit' },
          ],
        }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue([
        'dev-1',
        'dev-2',
      ]);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      // The ordinary send path, so capping, quiet hours, translations and
      // reporting all apply to a journey push unchanged.
      expect(pushNotifications.send).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          title: 'Welcome',
          body: 'Glad you are here',
          deepLinkUrl: 'https://example.com/home',
          deviceIdentityIds: ['dev-1', 'dev-2'],
        }),
        // A journey step is not a dashboard request, so it is not logged.
        null,
      );
      expect(segmentEvaluation.resolveDeviceIdentityIds).toHaveBeenCalledWith(
        'proj-1',
        ['user-1'],
      );
      expect(callOrder).toEqual(['claim', 'send']);
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1, stepsTaken: 1 }),
      );
    });

    it('sends an email step as an email campaign for that one person', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'send_email', subject: 'Welcome', html: '<p>Hi</p>', preheader: 'Start here' },
            { type: 'exit' },
          ],
        }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      emailCampaigns.countReachable.mockResolvedValueOnce(1);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(emailCampaigns.send).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'proj-1',
          subject: 'Welcome',
          html: '<p>Hi</p>',
          preheader: 'Start here',
          deviceIdentityIds: ['dev-1'],
        }),
        // A journey step is not a dashboard request, so it is not logged.
        null,
      );
      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1, stepsTaken: 1 }),
      );
    });

    it('sends an SMS step as an SMS campaign for that one person', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_sms', body: 'Your code is ready' }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      smsCampaigns.countReachable.mockResolvedValueOnce(1);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(smsCampaigns.send).toHaveBeenCalledWith({
        projectId: 'proj-1',
        body: 'Your code is ready',
        deviceIdentityIds: ['dev-1'],
      }, null);
      expect(emailCampaigns.send).not.toHaveBeenCalled();
      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1, stepsTaken: 1 }),
      );
    });

    it('sends a WhatsApp step as a WhatsApp campaign for that one person', async () => {
      const content = { template: { id: 'promo', name: 'promo', language: 'en' }, bodyParams: ['{{firstName|there}}'] };
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_whatsapp', content }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      whatsappCampaigns.countReachable.mockResolvedValueOnce(1);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(whatsappCampaigns.send).toHaveBeenCalledWith({
        projectId: 'proj-1',
        content,
        deviceIdentityIds: ['dev-1'],
      }, null);
      expect(smsCampaigns.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1, stepsTaken: 1 }),
      );
    });

    it('keeps a run moving when the person cannot be messaged on WhatsApp', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_whatsapp', content: { template: { id: 'promo', name: 'promo', language: 'en' }, bodyParams: ['{{firstName|there}}'] } }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      whatsappCampaigns.countReachable.mockResolvedValueOnce(0);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(whatsappCampaigns.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1 }),
      );
    });

    it('keeps a run moving when the person cannot be texted', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_sms', body: 'Hi' }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      smsCampaigns.countReachable.mockResolvedValueOnce(0);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(smsCampaigns.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1 }),
      );
    });

    it('keeps a run moving when the person cannot be emailed', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [{ type: 'send_email', subject: 'Welcome', html: '<p>Hi</p>' }, { type: 'exit' }],
        }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      emailCampaigns.countReachable.mockResolvedValueOnce(0);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(emailCampaigns.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1 }),
      );
      expect(runRepository.update.mock.calls[0][1]).not.toEqual(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('keeps a run moving when the person has no devices to push to', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'send_push', title: 'Welcome' },
            { type: 'exit' },
          ],
        }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue([]);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1 }),
      );
    });

    it('keeps a run moving when the person has a device but no usable token', async () => {
      // The live failure: a person registered through identify(), with no push
      // token because they never granted permission. `send` raises a
      // BadRequest for an audience of zero tokens, the generic catch around the
      // step turned that into a failed run, and they were dropped out of the
      // journey at its first push — never reaching the branch or exit after it.
      // That is the ordinary state of a large part of any real audience.
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [{ type: 'send_push', title: 'Welcome' }, { type: 'exit' }],
        }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      pushNotifications.countReachableDevices.mockResolvedValue(0);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1 }),
      );
      // Specifically not failed: there is nothing wrong with this journey.
      expect(runRepository.update.mock.calls[0][1]).not.toEqual(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('asks about reachability for the devices it resolved', async () => {
      // Guards against the count being asked with an empty list, which
      // resolveAudience reads as "no device filter" and answers for the whole
      // project — turning "this person is unreachable" into "somebody is".
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1', 'dev-2']);

      await scheduler.advanceDueRuns();

      expect(pushNotifications.countReachableDevices).toHaveBeenCalledWith(
        'proj-1',
        ['dev-1', 'dev-2'],
      );
    });

    it('still fails a run when the send itself goes wrong', async () => {
      // The distinction this whole change rests on: unreachable is benign,
      // a failing send is not, and the second must stay visible.
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }] }),
      ]);
      segmentEvaluation.resolveDeviceIdentityIds.mockResolvedValue(['dev-1']);
      pushNotifications.countReachableDevices.mockResolvedValue(3);
      pushNotifications.send.mockRejectedValue(new Error('FCM credentials rejected'));

      await expect(scheduler.advanceDueRuns()).resolves.toBe(0);

      const failed = runRepository.update.mock.calls.find(
        ([, update]: [unknown, Record<string, unknown>]) => update.status === 'failed',
      );
      expect(failed).toBeDefined();
      expect(failed[1].lastError).toMatch(/FCM credentials rejected/);
    });

    it('completes a run whose push was the last thing to say', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({ steps: [{ type: 'send_push', title: 'Goodbye' }] }),
      ]);

      await scheduler.advanceDueRuns();

      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ status: 'completed', nextDueAt: null }),
      );
    });

    it('takes the member path of a branch', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'branch', segmentId: 'seg-1', ifMember: 1, ifNot: 2 },
            { type: 'send_push', title: 'Member' },
            { type: 'send_push', title: 'Not a member' },
          ],
        }),
      ]);
      segmentRepository.findOne.mockResolvedValue({
        id: 'seg-1',
        projectId: 'proj-1',
      });
      segmentEvaluation.isMember.mockResolvedValue(true);

      await scheduler.advanceDueRuns();

      expect(segmentEvaluation.isMember).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'seg-1' }),
        'user-1',
      );
      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 1, stepsTaken: 1 }),
      );
    });

    it('takes the non-member path of a branch', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'branch', segmentId: 'seg-1', ifMember: 1, ifNot: 2 },
            { type: 'send_push', title: 'Member' },
            { type: 'send_push', title: 'Not a member' },
          ],
        }),
      ]);
      segmentRepository.findOne.mockResolvedValue({
        id: 'seg-1',
        projectId: 'proj-1',
      });
      segmentEvaluation.isMember.mockResolvedValue(false);

      await scheduler.advanceDueRuns();

      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ currentStepIndex: 2 }),
      );
    });

    it('resolves a branch one step per tick rather than running on', async () => {
      due([run()]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [
            { type: 'branch', segmentId: 'seg-1', ifMember: 1, ifNot: 1 },
            { type: 'send_push', title: 'Member' },
          ],
        }),
      ]);
      segmentRepository.findOne.mockResolvedValue({ id: 'seg-1' });
      segmentEvaluation.isMember.mockResolvedValue(true);

      await scheduler.advanceDueRuns();

      // The push belongs to the *next* tick: looping a run through step after
      // step would let one person monopolise the tick.
      expect(pushNotifications.send).not.toHaveBeenCalled();
      expect(runRepository.update).toHaveBeenCalledTimes(1);
    });

    it('marks an exited run and stops selecting it', async () => {
      due([run({ currentStepIndex: 1 })]);
      journeyRepository.find.mockResolvedValue([
        journey({
          steps: [{ type: 'send_push', title: 'Hi' }, { type: 'exit' }],
        }),
      ]);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      const update = runRepository.update.mock.calls[0][1];
      expect(update.status).toBe('exited');
      expect(update.completedAt).toBeInstanceOf(Date);
      // No next_due_at, and no longer active: the tick's select cannot see it.
      expect(update.nextDueAt).toBeNull();
    });

    it('fails a run the runner refuses to advance, with the reason', async () => {
      due([run({ stepsTaken: MAX_STEPS_PER_RUN })]);
      journeyRepository.find.mockResolvedValue([journey()]);

      await scheduler.advanceDueRuns();

      const update = runRepository.update.mock.calls[0][1];
      expect(update.status).toBe('failed');
      expect(update.lastError).toContain(`${MAX_STEPS_PER_RUN} steps`);
    });

    it('fails a run whose journey has been deleted underneath it', async () => {
      due([run({ journeyId: 'j-gone' })]);
      journeyRepository.find.mockResolvedValue([]);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(0);

      expect(runRepository.update.mock.calls[0][1]).toEqual(
        expect.objectContaining({ status: 'failed' }),
      );
    });

    it('fails only the run that throws and carries on with the rest', async () => {
      due([run({ id: 'run-bad' }), run({ id: 'run-good', journeyId: 'j-2' })]);
      journeyRepository.find.mockResolvedValue([
        journey({
          id: 'j-1',
          steps: [{ type: 'branch', segmentId: 'seg-gone', ifMember: 0, ifNot: 0 }],
        }),
        journey({ id: 'j-2' }),
      ]);
      // The bad journey points at a segment that no longer exists.
      segmentRepository.findOne.mockResolvedValue(null);

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(runRepository.update).toHaveBeenCalledWith(
        { id: 'run-bad' },
        expect.objectContaining({
          status: 'failed',
          lastError: expect.stringContaining('seg-gone'),
        }),
      );
      // The healthy run still took its step.
      expect(runRepository.update).toHaveBeenCalledWith(
        { id: 'run-good' },
        expect.objectContaining({ currentStepIndex: 1 }),
      );
    });

    it('fails only the run whose send throws', async () => {
      due([run({ id: 'run-bad' }), run({ id: 'run-good', journeyId: 'j-2' })]);
      journeyRepository.find.mockResolvedValue([
        journey({ id: 'j-1', steps: [{ type: 'send_push', title: 'Hi' }] }),
        journey({ id: 'j-2' }),
      ]);
      pushNotifications.send.mockRejectedValueOnce(new Error('FCM unavailable'));

      await expect(scheduler.advanceDueRuns()).resolves.toBe(1);

      expect(runRepository.update).toHaveBeenCalledWith(
        { id: 'run-bad' },
        expect.objectContaining({
          status: 'failed',
          lastError: 'FCM unavailable',
        }),
      );
    });
  });

  describe('reconciliation', () => {
    it('returns runs claimed longer than the threshold to the queue', async () => {
      qb.execute.mockResolvedValueOnce({ affected: 3 });

      await expect(scheduler.reconcileStrandedRuns()).resolves.toBe(3);

      // Claimed (no next_due_at), still active, and untouched for long enough
      // that no live instance can be working it.
      expect(qb.andWhere).toHaveBeenCalledWith('next_due_at IS NULL');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'updated_at < :staleBefore',
        expect.objectContaining({ staleBefore: expect.any(Date) }),
      );
      const [set] = qb.set.mock.calls[0];
      expect(set.nextDueAt).toBeInstanceOf(Date);
    });

    it('leaves everything alone when nothing is stranded', async () => {
      qb.execute.mockResolvedValueOnce({ affected: 0 });

      await expect(scheduler.reconcileStrandedRuns()).resolves.toBe(0);
    });
  });

  describe('the tick', () => {
    it('advances runs even when enrolment fails outright', async () => {
      journeyRepository.find.mockImplementation(async (options: any) =>
        options.where.status === 'active' ? Promise.reject(new Error('db down')) : [journey()],
      );
      runRepository.find.mockResolvedValue([run()]);

      await scheduler.handleTick();

      // People already inside a journey matter more than people about to join
      // it, so one must not block the other.
      expect(runRepository.update).toHaveBeenCalledTimes(1);
    });
  });

  describe('suspended tenants', () => {
    it('does not exclude anybody when nobody is suspended', async () => {
      await scheduler.advanceDueRuns();

      expect(runRepository.find.mock.calls[0][0].where).not.toHaveProperty('projectId');
    });

    it('moves a suspended journey\'s watermark on and enrols nobody, leaving other tenants alone', async () => {
      suspendedProjects = new Set(['suspended']);
      journeyRepository.find.mockResolvedValue([
        journey({ id: 'j-suspended', projectId: 'suspended' }),
        journey({ id: 'j-active', projectId: 'active' }),
      ]);
      runRepository.manager.query
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'r' }]);

      await expect(scheduler.enrolNewPeople()).resolves.toBe(1);

      expect(journeyRepository.update).toHaveBeenCalledWith(
        { id: 'j-suspended' },
        { enrolledThrough: expect.any(Date) },
      );
      // No query for the suspended project: every one carries the active tenant's id.
      for (const [, params] of runRepository.manager.query.mock.calls) {
        expect((params as unknown[])[0]).toBe('active');
      }
    });

    it('never drags a watermark that is ahead of this clock backwards', async () => {
      suspendedProjects = new Set(['suspended']);
      journeyRepository.find.mockResolvedValue([
        journey({ projectId: 'suspended', enrolledThrough: new Date(Date.now() + 60_000) }),
      ]);

      await scheduler.enrolNewPeople();

      expect(journeyRepository.update).not.toHaveBeenCalled();
    });
  });
});
