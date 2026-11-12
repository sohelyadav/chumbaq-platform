import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { JourneyEntity, JourneyStatus } from './entities/journey.entity';
import { JourneyRunEntity } from './entities/journey-run.entity';
import { SegmentEntity } from '../segments/entities/segment.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import {
  validateJourney,
  JourneyStep,
  JourneyTrigger,
} from './journey-definition';

export interface JourneyInput {
  name: string;
  description?: string | null;
  trigger: JourneyTrigger;
  steps: JourneyStep[];
}

@Injectable()
export class JourneysService {
  constructor(
    @InjectRepository(JourneyEntity)
    private readonly journeyRepository: Repository<JourneyEntity>,
    @InjectRepository(JourneyRunEntity)
    private readonly runRepository: Repository<JourneyRunEntity>,
    @InjectRepository(SegmentEntity)
    private readonly segmentRepository: Repository<SegmentEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  async findAll(projectId: string): Promise<JourneyEntity[]> {
    return this.journeyRepository.find({
      where: { projectId },
      order: { updatedAt: 'DESC' },
    });
  }

  async findOne(projectId: string, id: string): Promise<JourneyEntity> {
    const journey = await this.journeyRepository.findOne({
      where: { id, projectId },
    });
    if (!journey) throw new NotFoundException('Journey not found for this project');
    return journey;
  }

  async create(projectId: string, input: JourneyInput): Promise<JourneyEntity> {
    this.assertValid(input);
    await this.assertSegmentsInProject(projectId, input);

    return this.journeyRepository.save(
      this.journeyRepository.create({
        projectId,
        name: input.name,
        description: input.description ?? null,
        trigger: input.trigger,
        steps: input.steps,
        status: 'draft',
      }),
    );
  }

  /**
   * Edits a journey.
   *
   * Refused while active. People are partway through the steps as they stand,
   * and renumbering underneath them would move someone to a step that means
   * something else — or to one that no longer exists. Pausing first is the
   * deliberate act that makes the edit safe.
   */
  async update(
    projectId: string,
    id: string,
    input: Partial<JourneyInput>,
  ): Promise<JourneyEntity> {
    const journey = await this.findOne(projectId, id);

    if (journey.status === 'active') {
      throw new BadRequestException(
        'Pause this journey before editing it — people are partway through the steps as they are.',
      );
    }

    const next = {
      ...journey,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined
        ? { description: input.description ?? null }
        : {}),
      ...(input.trigger !== undefined ? { trigger: input.trigger } : {}),
      ...(input.steps !== undefined ? { steps: input.steps } : {}),
    };

    this.assertValid(next);
    await this.assertSegmentsInProject(projectId, next);
    return this.journeyRepository.save(next);
  }

  /**
   * Moves a journey between states.
   *
   * A journey going live for the first time sets the enrolment watermark to
   * now, so one switched on against a mature project enrols people who match
   * from here rather than everyone who ever did. Resuming a paused journey
   * leaves the watermark where it was, so the pause is a pause rather than a
   * silent restart.
   *
   * Pausing stops enrolment and leaves existing runs to finish: abandoning
   * someone between a message and its follow-up is worse than letting the
   * journey drain.
   *
   * A real change writes `journey.status_changed` (from, to) in the same transaction;
   * setting the status it already has writes nothing.
   */
  async setStatus(
    projectId: string,
    id: string,
    status: JourneyStatus,
    requester: ActivityRequester,
  ): Promise<JourneyEntity> {
    const journey = await this.findOne(projectId, id);
    let enrolledThrough: Date | undefined;

    if (status === 'active') {
      const problem = validateJourney(journey.trigger, journey.steps);
      if (problem) {
        throw new BadRequestException(
          `This journey cannot be activated: ${problem}`,
        );
      }
      // Journeys saved before segment ids were checked may name another
      // project's segment; refuse to (re)activate them.
      await this.assertSegmentsInProject(projectId, journey);

      // The watermark is set when a journey first goes live, and left alone
      // when a paused one resumes. Resetting it on resume would make a pause
      // a silent stop-and-restart: everyone who matched the trigger while it
      // was paused would be skipped, invisibly, which is not what pausing to
      // fix something for an afternoon is meant to cost.
      //
      // The backlog that then drains is bounded by the runner's own batching
      // rather than arriving at once.
      if (journey.status !== 'paused') {
        enrolledThrough = new Date();
      }
    }

    const from = journey.status;
    return this.journeyRepository.manager.transaction(async (manager) => {
      const journeys = manager.getRepository(JourneyEntity);
      // Conditional on the status read above, so of two requests racing to make the
      // same change only one moves the row, and only that one writes the entry.
      const result = await journeys.update(
        { id, projectId, status: from },
        { status, ...(enrolledThrough ? { enrolledThrough } : {}) },
      );
      const saved = await journeys.findOne({ where: { id, projectId } });
      if (!saved) throw new NotFoundException('Journey not found for this project');
      if (result.affected && from !== status) {
        await recordBy(
          this.activity,
          requester,
          {
            projectId,
            action: 'journey.status_changed',
            target: { type: 'journey', id: saved.id, label: saved.name },
            details: { from, to: status },
          },
          manager,
        );
      }
      return saved;
    });
  }

  /** How the journey is doing, counted from its runs. */
  async getStats(
    projectId: string,
    id: string,
  ): Promise<{
    active: number;
    completed: number;
    exited: number;
    failed: number;
  }> {
    await this.findOne(projectId, id);

    const rows = await this.runRepository
      .createQueryBuilder('run')
      .select('run.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('run.journey_id = :id', { id })
      .groupBy('run.status')
      .getRawMany<{ status: string; count: string }>();

    const counts = { active: 0, completed: 0, exited: 0, failed: 0 };
    for (const row of rows) {
      if (row.status in counts) {
        counts[row.status as keyof typeof counts] = Number(row.count);
      }
    }
    return counts;
  }

  async remove(projectId: string, id: string, requester: ActivityRequester): Promise<void> {
    const journey = await this.findOne(projectId, id);
    if (journey.status === 'active') {
      // The reason is that it is live and still enrolling, which is what was
      // actually checked. The previous wording claimed people were inside it —
      // a statement about runs, from a test that only looked at status, and so
      // wrong for a journey nobody has entered yet.
      throw new BadRequestException(
        'Pause this journey before deleting it — it is live and still enrolling people.',
      );
    }
    const entry = contentDeleted(projectId, 'journey', { id: journey.id, name: journey.name });
    await this.journeyRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(JourneyEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('Journey not found for this project');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  /**
   * Every segment a journey names (its trigger and branch steps) must be one
   * of this project's. The scheduler reads segment_members by segment id alone,
   * so a foreign id would copy another tenant's members into this journey.
   */
  private async assertSegmentsInProject(
    projectId: string,
    input: { trigger: JourneyTrigger; steps: JourneyStep[] },
  ): Promise<void> {
    const ids = new Set<string>();
    if (input.trigger?.type === 'segment_entry') ids.add(input.trigger.segmentId);
    for (const step of input.steps ?? []) {
      if (step.type === 'branch') ids.add(step.segmentId);
    }
    if (ids.size === 0) return;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if ([...ids].some((id) => !UUID.test(id))) {
      throw new BadRequestException('A segment in this journey does not belong to this project.');
    }
    const found = await this.segmentRepository.count({
      where: { id: In([...ids]), projectId },
    });
    if (found !== ids.size) {
      throw new BadRequestException('A segment in this journey does not belong to this project.');
    }
  }

  private assertValid(input: {
    trigger: JourneyTrigger;
    steps: JourneyStep[];
  }): void {
    const problem = validateJourney(input.trigger, input.steps);
    if (problem) throw new BadRequestException(problem);
  }
}
