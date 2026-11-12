import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, LessThanOrEqual, Not, Repository } from 'typeorm';
import { JourneyEntity } from '../../modules/journeys/entities/journey.entity';
import { JourneyRunEntity } from '../../modules/journeys/entities/journey-run.entity';
import { advance, decideNextStep } from '../../modules/journeys/journey-runner';
import { SegmentEntity } from '../../modules/segments/entities/segment.entity';
import { SegmentEvaluationService } from '../../modules/segments/segment-evaluation.service';
import { PushNotificationsService } from '../../modules/push-notifications/push-notifications.service';
import { EmailCampaignsService } from '../../modules/email/email-campaigns.service';
import { SmsCampaignsService } from '../../modules/sms/sms-campaigns.service';
import { WhatsAppCampaignsService } from '../../modules/whatsapp/whatsapp-campaigns.service';
import { SendEmailStep, SendSmsStep, SendWhatsAppStep } from '../../modules/journeys/journey-definition';
import { ProjectSuspensionService } from '../../modules/projects/project-suspension.service';

/**
 * How many people one journey may enrol in one page, and how many pages it may
 * take per tick. A project with a million matching people must not become one
 * statement or one tick's worth of work, so enrolment is paged and each pass
 * leaves the rest for the next minute — the watermark is what makes stopping
 * halfway safe.
 */
const ENROLMENT_PAGE_SIZE = 500;
const MAX_ENROLMENT_PAGES_PER_TICK = 20;

/**
 * How many runs one tick will advance. Ordered by how long they have been due,
 * so a backlog drains oldest-first rather than starving anyone.
 */
const MAX_RUNS_PER_TICK = 500;

/**
 * Tolerance on the "is this run due?" test.
 *
 * A tick's `now` lands a few milliseconds after the cron boundary that woke
 * it, and a wait step's due time is computed from that `now` — so a 60-second
 * wait decided at 00:06:00.030 comes due at 00:07:00.030, and the 00:07:00.000
 * tick finds it 30ms early. The run then waits a further whole minute.
 *
 * Measured live: a run enrolled at 00:06:00.024 with a 60-second wait was still
 * sitting on that wait at 00:07:39, due at 00:07:00.030.
 *
 * `MIN_WAIT_SECONDS` is 60 and the tick is every minute, so the shortest wait
 * the product allows is exactly the one that doubles. Longer waits were only
 * ever one tick late, which is why this went unnoticed. The segment refresh
 * scheduler had the same bug for the same reason; see
 * SEGMENT_REFRESH_GRACE_SECONDS.
 *
 * Five seconds is far below the tick period, so it cannot bring a wait forward
 * by a whole tick, and well above the time a tick needs to decide a step.
 */
const DUE_GRACE_SECONDS = 5;

/**
 * How long a claimed run may sit untouched before the sweep hands it back.
 *
 * A claim clears `next_due_at` and bumps `updated_at`, so a run being worked
 * right now looks fresh. Only a run whose instance died between claiming and
 * resolving stays claimed with an ageing `updated_at`, and this window has to
 * comfortably exceed one step — a push send is the slowest, and it enqueues
 * rather than delivers.
 */
const STRANDED_CLAIM_MS = 10 * 60 * 1000;

/**
 * A journey step is the platform acting on its own, not a dashboard request: the
 * activity log records who activated the journey (`journey.status_changed`), and
 * not each send it makes afterwards this round.
 */
const JOURNEY_SEND = null;

/**
 * Runs journeys: enrols people who newly match a trigger, then advances one
 * step of every run whose time has come.
 *
 * Both halves assume two API instances are running this tick at the same
 * moment. Enrolment leans on the partial unique index rather than reading
 * first — a read-then-insert races itself and enrols somebody twice — and
 * advancing claims each run with a conditional UPDATE before doing anything,
 * because a run advanced twice sends the same person the same push twice.
 */
@Injectable()
export class JourneyScheduler {
  private readonly logger = new Logger(JourneyScheduler.name);

  constructor(
    @InjectRepository(JourneyEntity)
    private readonly journeyRepository: Repository<JourneyEntity>,
    @InjectRepository(JourneyRunEntity)
    private readonly runRepository: Repository<JourneyRunEntity>,
    @InjectRepository(SegmentEntity)
    private readonly segmentRepository: Repository<SegmentEntity>,
    private readonly segmentEvaluation: SegmentEvaluationService,
    private readonly pushNotifications: PushNotificationsService,
    private readonly emailCampaigns: EmailCampaignsService,
    private readonly smsCampaigns: SmsCampaignsService,
    private readonly whatsappCampaigns: WhatsAppCampaignsService,
    private readonly suspension: ProjectSuspensionService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleTick(): Promise<void> {
    // Enrolment first, so somebody who matched a moment ago takes their first
    // step on this tick rather than waiting a further minute.
    //
    // The two halves are isolated from each other on purpose: people already
    // inside a journey matter more than people about to join it, so a broken
    // trigger query must not stop every run in the project advancing.
    try {
      const enrolled = await this.enrolNewPeople();
      if (enrolled > 0) {
        this.logger.log(`Enrolled ${enrolled} person(s) into journeys`);
      }
    } catch (error) {
      this.logger.error(`Journey enrolment failed: ${detail(error)}`);
    }

    try {
      const advanced = await this.advanceDueRuns();
      if (advanced > 0) {
        this.logger.log(`Advanced ${advanced} journey run(s)`);
      }
    } catch (error) {
      this.logger.error(`Journey advancement failed: ${detail(error)}`);
    }
  }

  /**
   * Creates runs for people who newly match an active journey's trigger.
   *
   * Per journey, so one journey pointing at a segment that has been deleted
   * cannot stop every other journey enrolling.
   */
  async enrolNewPeople(): Promise<number> {
    const journeys = await this.journeyRepository.find({
      where: { status: 'active' },
    });

    const suspended = await this.suspension.suspendedProjectIds();

    let enrolled = 0;

    for (const journey of journeys) {
      try {
        if (suspended.has(journey.projectId)) {
          await this.holdEnrolment(journey);
          continue;
        }

        switch (journey.trigger?.type) {
          case 'event':
            enrolled += await this.enrolFromEvents(journey);
            break;
          case 'segment_entry':
            enrolled += await this.enrolFromSegment(journey);
            break;
          default:
            // Validation rejects this on activation, so it means the row was
            // written around the API. Logged rather than thrown: it is one
            // journey's problem, not the tick's.
            this.logger.warn(
              `Journey ${journey.id} has an unknown trigger and cannot enrol anybody`,
            );
        }
      } catch (error) {
        this.logger.error(
          `Journey ${journey.id} could not enrol: ${detail(error)}`,
        );
      }
    }

    return enrolled;
  }

  /**
   * Keeps a suspended tenant's journey from enrolling, and from owing anything.
   *
   * SDK ingest carries on during a suspension and segments keep materialising,
   * so the triggers keep arriving. Simply leaving the watermark where it is would
   * enrol everyone who fired one, all at once, the minute the tenant is
   * reactivated. Moving it forward means enrolment resumes from reactivation.
   * Never backwards, for the clock-skew reason given in `enrolFromEvents`.
   */
  private async holdEnrolment(journey: JourneyEntity): Promise<void> {
    const now = new Date();
    if (journey.enrolledThrough && journey.enrolledThrough.getTime() >= now.getTime()) {
      return;
    }
    await this.journeyRepository.update({ id: journey.id }, { enrolledThrough: now });
  }

  /**
   * Enrols everyone who fired the trigger event since the watermark.
   *
   * `enrolledThrough` is the whole reason activating a journey on a mature
   * project is safe: without it every person who ever fired the event would be
   * swept in on the first tick. JourneysService sets it to the moment of
   * activation; this only ever moves it forward.
   *
   * Each page is bounded by *time*, not by row count, and the boundary is a
   * timestamp that exists in the data. That matters at the page edge: several
   * people can share one event timestamp to the microsecond (a batched SDK
   * flush does exactly this), and a boundary drawn mid-tie with a `>` on the
   * next pass would silently drop everyone after the cut. Selecting
   * `> previous AND <= boundary` takes whole ties every time.
   */
  private async enrolFromEvents(journey: JourneyEntity): Promise<number> {
    const now = new Date();

    if (!journey.enrolledThrough) {
      // A journey with no watermark — activated before the watermark existed,
      // or written straight into the database. Starting it here enrols nobody
      // this tick, which is the safe direction: the other reading of a null
      // watermark is "the beginning of time", and that pushes the entire
      // history of the project at once.
      await this.journeyRepository.update(
        { id: journey.id, enrolledThrough: IsNull() },
        { enrolledThrough: now },
      );
      this.logger.warn(
        `Journey ${journey.id} had no enrolment watermark; starting from now`,
      );
      return 0;
    }

    const trigger = journey.trigger as { type: 'event'; eventName: string };
    let watermark = journey.enrolledThrough;
    let enrolled = 0;

    for (let page = 0; page < MAX_ENROLMENT_PAGES_PER_TICK; page += 1) {
      const boundary = await this.nextEventBoundary(
        journey.projectId,
        trigger.eventName,
        watermark,
        now,
      );

      // A watermark ahead of the tick's ceiling — clock skew between the API
      // instance that activated the journey and this one — would otherwise be
      // dragged backwards to `now` over an empty range. There is nothing to
      // enrol either way, so stop instead.
      if (boundary.getTime() <= watermark.getTime()) break;

      enrolled += await this.insertRunsForEvents(
        journey,
        trigger.eventName,
        watermark,
        boundary,
      );

      // Conditional on the value this instance read. If another instance is
      // enrolling the same journey it has already moved the watermark on, and
      // this one stops rather than re-walking pages it would only conflict on.
      const moved = await this.journeyRepository.update(
        { id: journey.id, enrolledThrough: watermark },
        { enrolledThrough: boundary },
      );
      if (!moved.affected) break;

      watermark = boundary;
      // The boundary only reaches the tick's ceiling when the remaining
      // matches fitted in one page, so this journey is caught up.
      if (boundary.getTime() >= now.getTime()) break;
    }

    return enrolled;
  }

  /**
   * The timestamp one page in, or the tick's ceiling when fewer than a page
   * of events remain. Bounding by the ceiling as well as the watermark keeps
   * the pass finite while events keep arriving.
   */
  private async nextEventBoundary(
    projectId: string,
    eventName: string,
    after: Date,
    ceiling: Date,
  ): Promise<Date> {
    const rows = await this.runRepository.manager.query(
      `SELECT e.timestamp AS boundary
       FROM user_events e
       WHERE e.project_id = $1
         AND e.event_name = $2
         AND e.timestamp > $3
         AND e.timestamp <= $4
       ORDER BY e.timestamp ASC
       OFFSET $5 LIMIT 1`,
      [projectId, eventName, after, ceiling, ENROLMENT_PAGE_SIZE],
    );

    const boundary = (rows as Array<{ boundary: Date | string }>)[0]?.boundary;
    return boundary ? new Date(boundary) : ceiling;
  }

  /**
   * One page of enrolments, as a single insert.
   *
   * People are keyed exactly the way segments key them — a distinct id where
   * there is one, the device otherwise — so somebody on three devices runs a
   * journey once. `ON CONFLICT DO NOTHING` against the partial unique index is
   * the one-run-at-a-time rule: checking for an existing run first would race
   * the other instance's insert.
   */
  private async insertRunsForEvents(
    journey: JourneyEntity,
    eventName: string,
    after: Date,
    through: Date,
  ): Promise<number> {
    const rows = await this.runRepository.manager.query(
      `INSERT INTO journey_runs
         (project_id, journey_id, person_key, current_step_index, steps_taken, status, next_due_at)
       SELECT DISTINCT $1::uuid, $2::uuid,
              COALESCE(d.external_user_id, 'device:' || d.id::text),
              0, 0, 'active', NOW()
       FROM user_events e
       JOIN device_identities d ON d.id = e.device_identity_id AND d.project_id = $1
       WHERE e.project_id = $1
         AND e.event_name = $3
         AND e.timestamp > $4
         AND e.timestamp <= $5
       ON CONFLICT (journey_id, person_key) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [journey.projectId, journey.id, eventName, after, through],
    );

    return (rows as unknown[]).length;
  }

  /**
   * Enrols members of the trigger segment who have not been through this
   * journey yet.
   *
   * `segment_members` records membership, not entry — nothing in it says when
   * somebody joined — so "newly matched" has to be read as "is a member and
   * has no run". The anti-join covers *every* status rather than only active
   * runs: keyed on active runs alone, somebody who finished the journey while
   * still in the segment would be enrolled again on the very next tick, and
   * pushed the same sequence forever. The conflict clause stays as the guard
   * against the other instance inserting between this one's read and write.
   *
   * The cursor advances within the tick, and across ticks the anti-join is
   * what moves the page on, so enrolment resumes where it stopped without
   * needing a watermark this trigger has no way to compute.
   */
  private async enrolFromSegment(journey: JourneyEntity): Promise<number> {
    const now = new Date();

    if (!journey.enrolledThrough) {
      // Same reasoning as the event trigger: a null watermark read as "the
      // beginning of time" would enrol the whole segment at once.
      await this.journeyRepository.update(
        { id: journey.id, enrolledThrough: IsNull() },
        { enrolledThrough: now },
      );
      this.logger.warn(
        `Journey ${journey.id} had no enrolment watermark; starting from now`,
      );
      return 0;
    }

    const trigger = journey.trigger as {
      type: 'segment_entry';
      segmentId: string;
    };
    let watermark = journey.enrolledThrough;
    let enrolled = 0;

    for (let page = 0; page < MAX_ENROLMENT_PAGES_PER_TICK; page += 1) {
      const boundary = await this.nextSegmentBoundary(
        journey.projectId,
        trigger.segmentId,
        watermark,
        now,
      );
      if (boundary.getTime() <= watermark.getTime()) break;

      enrolled += await this.insertRunsForSegment(
        journey,
        trigger.segmentId,
        watermark,
        boundary,
      );

      const moved = await this.journeyRepository.update(
        { id: journey.id, enrolledThrough: watermark },
        { enrolledThrough: boundary },
      );
      if (!moved.affected) break;

      watermark = boundary;
      if (boundary.getTime() >= now.getTime()) break;
    }

    return enrolled;
  }

  /**
   * The `entered_at` bounding the next page, or the tick's ceiling.
   *
   * Read from the data rather than computed, so a moment shared by hundreds of
   * people who entered together is never cut in half — half enrolled now, half
   * skipped when the watermark steps past them.
   */
  private async nextSegmentBoundary(
    projectId: string,
    segmentId: string,
    after: Date,
    ceiling: Date,
  ): Promise<Date> {
    // The segment must be the journey's project's: segment_members has no
    // project column, and journeys saved before ids were checked may name
    // another project's segment.
    const rows = await this.runRepository.manager.query(
      `SELECT m.entered_at AS boundary
       FROM segment_members m
       JOIN segments s ON s.id = m.segment_id AND s.project_id = $5::uuid
       WHERE m.segment_id = $1::uuid
         AND m.entered_at > $2
         AND m.entered_at <= $3
       ORDER BY m.entered_at ASC
       OFFSET $4 LIMIT 1`,
      [segmentId, after, ceiling, ENROLMENT_PAGE_SIZE, projectId],
    );

    const boundary = (rows as Array<{ boundary: Date | string }>)[0]?.boundary;
    return boundary ? new Date(boundary) : ceiling;
  }

  /**
   * Enrols everyone who entered the segment in this window.
   *
   * Keyed on when they entered rather than on whether they have ever run this
   * journey, which is what allows re-entry: someone who leaves a segment and
   * comes back gets a fresh `entered_at`, and so enters the journey again.
   * While membership was rebuilt wholesale on every refresh there was no such
   * timestamp, and the only safe rule was once per person ever.
   *
   * The partial unique index still stops somebody being enrolled twice while a
   * run of theirs is active.
   */
  private async insertRunsForSegment(
    journey: JourneyEntity,
    segmentId: string,
    after: Date,
    through: Date,
  ): Promise<number> {
    const rows = await this.runRepository.manager.query(
      `INSERT INTO journey_runs
         (project_id, journey_id, person_key, current_step_index, steps_taken, status, next_due_at)
       SELECT $1::uuid, $2::uuid, m.person_key, 0, 0, 'active', NOW()
       FROM segment_members m
       JOIN segments s ON s.id = m.segment_id AND s.project_id = $1::uuid
       WHERE m.segment_id = $3::uuid
         AND m.entered_at > $4
         AND m.entered_at <= $5
       ON CONFLICT (journey_id, person_key) WHERE status = 'active' DO NOTHING
       RETURNING id`,
      [journey.projectId, journey.id, segmentId, after, through],
    );

    return (rows as unknown[]).length;
  }

  /**
   * Carries out one step of every run whose time has come.
   *
   * One step per run per tick, deliberately. A wait bounds a run's progress
   * naturally; looping a run through step after step in one pass would let a
   * single person's journey monopolise the tick, and would turn a definition
   * that only *nearly* cycles into a stall.
   */
  async advanceDueRuns(): Promise<number> {
    const now = new Date();
    // What counts as due this tick. Separate from `now` because a step's due
    // time is derived from a previous tick's `now`, which sits just after the
    // cron boundary; see DUE_GRACE_SECONDS. Used for the claim below
    // as well — a select that admits a run the claim then refuses would spin
    // the tick doing nothing.
    const dueAsOf = new Date(now.getTime() + DUE_GRACE_SECONDS * 1000);

    // Excluded in the read rather than skipped afterwards: this is bounded and
    // oldest-first, and a suspended tenant's runs only get older, so they would
    // otherwise fill every tick and stop all other tenants' journeys. The runs
    // are left as they are, and reactivation moves them on by the suspension's length.
    const suspended = await this.suspension.suspendedProjectIds();

    const due = await this.runRepository.find({
      where: {
        status: 'active',
        nextDueAt: LessThanOrEqual(dueAsOf),
        ...(suspended.size > 0 ? { projectId: Not(In([...suspended])) } : {}),
      },
      order: { nextDueAt: 'ASC' },
      take: MAX_RUNS_PER_TICK,
    });

    if (due.length === 0) return 0;

    // One read for the definitions rather than one per run: a backlog is
    // typically many people on a handful of journeys.
    const journeys = await this.journeyRepository.find({
      where: { id: In([...new Set(due.map((run) => run.journeyId))]) },
    });
    const byId = new Map(journeys.map((journey) => [journey.id, journey]));

    let advanced = 0;

    for (const run of due) {
      try {
        if (await this.advanceRun(run, byId.get(run.journeyId), now, dueAsOf)) {
          advanced += 1;
        }
      } catch (error) {
        // One person's failed send, or one journey's dangling segment
        // reference, must not stop every other run advancing. The run carries
        // the reason so it can be seen; the tick carries on.
        const reason = detail(error);
        this.logger.error(
          `Journey run ${run.id} could not take its next step: ${reason}`,
        );
        await this.failRun(run.id, reason).catch(() => undefined);
      }
    }

    return advanced;
  }

  /**
   * `now` and `dueAsOf` are both needed and are not interchangeable: the claim
   * has to admit the same runs the select did, so it uses the tolerant
   * cut-off, while the next wait is measured from the real clock. Claiming on
   * `now` would refuse exactly the runs the grace exists to catch.
   */
  private async advanceRun(
    run: JourneyRunEntity,
    journey: JourneyEntity | undefined,
    now: Date,
    dueAsOf: Date,
  ): Promise<boolean> {
    if (!(await this.claim(run, dueAsOf))) return false;

    if (!journey) {
      // journey_runs cascades from journeys, so this is a run whose journey
      // was deleted between the two reads above. Nothing can advance it.
      await this.failRun(run.id, 'The journey this run belongs to no longer exists.');
      return false;
    }

    const outcome = decideNextStep(
      journey.steps,
      { currentStepIndex: run.currentStepIndex, stepsTaken: run.stepsTaken },
      now,
    );

    switch (outcome.kind) {
      case 'wait':
        await this.moveTo(run, outcome.nextStepIndex, outcome.until);
        return true;

      case 'send_push': {
        const step = outcome.step;
        if (step.type !== 'send_push') {
          // Unreachable through decideNextStep; narrowing rather than casting
          // keeps it that way if the outcome ever carries something else.
          await this.failRun(run.id, 'This step is not a push step.');
          return false;
        }
        await this.sendJourneyPush(run, journey, step);
        // Due immediately: the step has happened, and the next tick carries
        // out whatever follows it.
        await this.moveTo(run, outcome.nextStepIndex, now);
        return true;
      }

      case 'send_email': {
        const step = outcome.step;
        if (step.type !== 'send_email') {
          await this.failRun(run.id, 'This step is not an email step.');
          return false;
        }
        await this.sendJourneyEmail(run, step);
        await this.moveTo(run, outcome.nextStepIndex, now);
        return true;
      }

      case 'send_sms': {
        const step = outcome.step;
        if (step.type !== 'send_sms') {
          await this.failRun(run.id, 'This step is not a text message step.');
          return false;
        }
        await this.sendJourneySms(run, step);
        await this.moveTo(run, outcome.nextStepIndex, now);
        return true;
      }

      case 'send_whatsapp': {
        const step = outcome.step;
        if (step.type !== 'send_whatsapp') {
          await this.failRun(run.id, 'This step is not a WhatsApp step.');
          return false;
        }
        await this.sendJourneyWhatsApp(run, step);
        await this.moveTo(run, outcome.nextStepIndex, now);
        return true;
      }

      case 'branch': {
        const segment = await this.segmentRepository.findOne({
          where: { id: outcome.segmentId, projectId: run.projectId },
        });
        if (!segment) {
          // Thrown rather than silently taking the non-member path: guessing
          // would send somebody down a branch nobody chose for them.
          throw new Error(
            `Branch step points at segment ${outcome.segmentId}, which no longer exists.`,
          );
        }
        const member = await this.segmentEvaluation.isMember(
          segment,
          run.personKey,
        );
        await this.moveTo(
          run,
          member ? outcome.ifMember : outcome.ifNot,
          now,
        );
        return true;
      }

      case 'finished':
        await this.finishRun(run.id, outcome.reason);
        return true;

      case 'failed':
        await this.failRun(run.id, outcome.reason);
        return true;
    }
  }

  /**
   * Takes ownership of one run.
   *
   * Both instances issue this UPDATE against the same row; Postgres serialises
   * them, and the loser re-checks the row it was blocked on, finds
   * `next_due_at` already NULL and matches nothing. So exactly one instance
   * gets `affected > 0` and carries out the step — which is the whole defence
   * against sending one person the same push twice.
   *
   * Clearing `next_due_at` is also what marks a run as in flight, so the sweep
   * below can tell a run being worked from one whose instance died.
   */
  private async claim(run: JourneyRunEntity, now: Date): Promise<boolean> {
    const claimed = await this.runRepository
      .createQueryBuilder()
      .update(JourneyRunEntity)
      .set({ nextDueAt: null })
      .where('id = :id', { id: run.id })
      .andWhere('status = :status', { status: 'active' })
      .andWhere('next_due_at IS NOT NULL')
      .andWhere('next_due_at <= :now', { now })
      .execute();

    return (claimed.affected ?? 0) > 0;
  }

  /**
   * Sends one step's push as a real campaign aimed at one person.
   *
   * Deliberately the ordinary send path: frequency capping, quiet hours,
   * translations, per-channel delivery and every report already work on
   * campaigns, and a second sender would have to reimplement all of it and
   * then drift from it.
   */
  private async sendJourneyPush(
    run: JourneyRunEntity,
    journey: JourneyEntity,
    step: { title: string; body?: string; imageUrl?: string; deepLinkUrl?: string },
  ): Promise<void> {
    const deviceIdentityIds =
      await this.segmentEvaluation.resolveDeviceIdentityIds(run.projectId, [
        run.personKey,
      ]);

    if (deviceIdentityIds.length === 0) {
      // Nobody to send to. The run carries on rather than failing: the rest of
      // the journey may still branch or exit meaningfully for this person, and
      // there is nothing here to retry.
      this.logger.warn(
        `Journey run ${run.id} skipped a push: ${run.personKey} has no devices`,
      );
      return;
    }

    // Having a device is not the same as being reachable on it. `send` raises
    // a BadRequest when an audience resolves to no tokens — the right answer
    // for a marketer pressing Send, and fatal here: the generic catch around
    // this step turned it into a failed run, so anyone who declined
    // notification permission was dropped out of the journey at its first push
    // step and never reached the branches or exits after it. Observed live on
    // a person with a registered device and no token.
    //
    // The same applies to someone merely at the project's daily frequency cap,
    // which is as benign a reason as there is. So this is the no-devices case
    // in a wider form, and it is handled the same way.
    const reachable = await this.pushNotifications.countReachableDevices(
      run.projectId,
      deviceIdentityIds,
    );
    if (reachable === 0) {
      this.logger.warn(
        `Journey run ${run.id} skipped a push: ${run.personKey} has no reachable push tokens (none, opted out, or capped)`,
      );
      return;
    }

    await this.pushNotifications.send({
      projectId: run.projectId,
      title: step.title,
      body: step.body,
      imageUrl: step.imageUrl,
      deepLinkUrl: step.deepLinkUrl,
      deviceIdentityIds,
      // Carried into the payload so a tap can be attributed back to the
      // journey rather than looking like a one-off campaign. The step index is
      // included because a stranded run repeats its step: it is what tells a
      // duplicate apart from a second, intentional send later in the journey,
      // and what an idempotency check would key on if this is ever tightened
      // from at-least-once.
      data: {
        journey_id: journey.id,
        journey_run_id: run.id,
        journey_step: String(run.currentStepIndex),
      },
    }, JOURNEY_SEND);
  }

  /**
   * Sends one step's email as a campaign aimed at one person.
   *
   * The push step's reasoning holds here unchanged: the ordinary send path
   * already applies consent, suppression, the frequency cap and reporting,
   * and someone who cannot be emailed — no address, not opted in,
   * unsubscribed — carries on through the journey rather than failing it.
   */
  private async sendJourneyEmail(run: JourneyRunEntity, step: SendEmailStep): Promise<void> {
    const deviceIdentityIds =
      await this.segmentEvaluation.resolveDeviceIdentityIds(run.projectId, [
        run.personKey,
      ]);

    const reachable = await this.emailCampaigns.countReachable(
      run.projectId,
      deviceIdentityIds,
    );
    if (reachable === 0) {
      this.logger.warn(
        `Journey run ${run.id} skipped an email: ${run.personKey} cannot be emailed`,
      );
      return;
    }

    await this.emailCampaigns.send({
      projectId: run.projectId,
      subject: step.subject,
      html: step.html,
      text: step.text,
      preheader: step.preheader,
      deviceIdentityIds,
    }, JOURNEY_SEND);
  }

  /**
   * Texts one step's message to one person, as the email step does: through
   * the ordinary send path, skipping someone who cannot be texted rather
   * than failing their run.
   */
  private async sendJourneySms(run: JourneyRunEntity, step: SendSmsStep): Promise<void> {
    const deviceIdentityIds =
      await this.segmentEvaluation.resolveDeviceIdentityIds(run.projectId, [
        run.personKey,
      ]);

    const reachable = await this.smsCampaigns.countReachable(
      run.projectId,
      deviceIdentityIds,
    );
    if (reachable === 0) {
      this.logger.warn(
        `Journey run ${run.id} skipped a text: ${run.personKey} cannot be texted`,
      );
      return;
    }

    await this.smsCampaigns.send({
      projectId: run.projectId,
      body: step.body,
      deviceIdentityIds,
    }, JOURNEY_SEND);
  }

  /**
   * Sends one step's WhatsApp template to one person, through the ordinary
   * send path, skipping someone who cannot be messaged rather than failing
   * their run.
   */
  private async sendJourneyWhatsApp(run: JourneyRunEntity, step: SendWhatsAppStep): Promise<void> {
    const deviceIdentityIds =
      await this.segmentEvaluation.resolveDeviceIdentityIds(run.projectId, [run.personKey]);

    const reachable = await this.whatsappCampaigns.countReachable(run.projectId, deviceIdentityIds);
    if (reachable === 0) {
      this.logger.warn(
        `Journey run ${run.id} skipped a WhatsApp message: ${run.personKey} cannot be messaged`,
      );
      return;
    }

    await this.whatsappCampaigns.send({
      projectId: run.projectId,
      content: step.content as never,
      deviceIdentityIds,
    }, JOURNEY_SEND);
  }

  /** Moves a run to its next step, or completes it when there is none. */
  private async moveTo(
    run: JourneyRunEntity,
    nextStepIndex: number,
    dueAt: Date,
  ): Promise<void> {
    const next = advance(
      { currentStepIndex: run.currentStepIndex, stepsTaken: run.stepsTaken },
      nextStepIndex,
    );

    if (!next) {
      await this.finishRun(run.id, 'completed');
      return;
    }

    await this.runRepository.update(
      { id: run.id },
      {
        currentStepIndex: next.currentStepIndex,
        stepsTaken: next.stepsTaken,
        nextDueAt: dueAt,
      },
    );
  }

  private async finishRun(
    id: string,
    reason: 'completed' | 'exited',
  ): Promise<void> {
    await this.runRepository.update(
      { id },
      { status: reason, completedAt: new Date(), nextDueAt: null },
    );
  }

  private async failRun(id: string, reason: string): Promise<void> {
    await this.runRepository.update(
      { id },
      {
        status: 'failed',
        lastError: reason,
        completedAt: new Date(),
        nextDueAt: null,
      },
    );
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async handleStrandedRuns(): Promise<void> {
    const count = await this.reconcileStrandedRuns();
    if (count > 0) {
      this.logger.warn(`Returned ${count} stranded journey run(s) to the queue`);
    }
  }

  /**
   * Hands back runs that were claimed and never resolved.
   *
   * An instance that dies between claiming a run and writing its outcome
   * leaves that person stopped mid-journey with nothing to move them on —
   * permanently, because a claimed run has no `next_due_at` for the tick to
   * select. This is the only thing that notices.
   *
   * Making the run due again rather than failing it is the deliberate choice:
   * the crash may have been after a push went out, so the step can repeat, but
   * a rare duplicate is recoverable where abandoning somebody between a
   * message and its follow-up is not. Frequency capping in the send path
   * blunts the duplicate; nothing blunts an abandoned journey.
   *
   * Split out from the cron handler so it can be tested and triggered
   * manually.
   */
  async reconcileStrandedRuns(): Promise<number> {
    const staleBefore = new Date(Date.now() - STRANDED_CLAIM_MS);

    const returned = await this.runRepository
      .createQueryBuilder()
      .update(JourneyRunEntity)
      .set({ nextDueAt: new Date() })
      .where('status = :status', { status: 'active' })
      // A run being worked right now looks exactly like this except that its
      // updated_at was bumped by the claim, which is why the age test is what
      // separates the two.
      .andWhere('next_due_at IS NULL')
      .andWhere('updated_at < :staleBefore', { staleBefore })
      .execute();

    return returned.affected ?? 0;
  }
}

function detail(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}
