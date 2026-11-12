import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { InAppMessageEntity, MessageStatus } from './entities/in-app-message.entity';
import { CreateInAppMessageDto } from './dto/create-in-app-message.dto';
import { UpdateInAppMessageDto } from './dto/update-in-app-message.dto';

@Injectable()
export class InAppMessagesService {
  private readonly logger = new Logger(InAppMessagesService.name);

  constructor(
    @InjectRepository(InAppMessageEntity)
    private readonly messageRepo: Repository<InAppMessageEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  async create(
    projectId: string,
    dto: CreateInAppMessageDto,
    userId?: string,
  ): Promise<InAppMessageEntity> {
    const message = this.messageRepo.create({
      ...dto,
      projectId,
      startsAt: dto.startsAt ? new Date(dto.startsAt) : null,
      endsAt: dto.endsAt ? new Date(dto.endsAt) : null,
      createdBy: userId || null,
    });
    return this.messageRepo.save(message);
  }

  async findAll(
    projectId: string,
    opts?: { status?: MessageStatus; limit?: number; offset?: number },
  ): Promise<{ data: InAppMessageEntity[]; total: number }> {
    const qb = this.messageRepo
      .createQueryBuilder('msg')
      .where('msg.project_id = :projectId', { projectId });

    if (opts?.status) {
      qb.andWhere('msg.status = :status', { status: opts.status });
    }

    qb.orderBy('msg.updated_at', 'DESC')
      .take(opts?.limit || 50)
      .skip(opts?.offset || 0);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async findOne(id: string, projectId: string): Promise<InAppMessageEntity> {
    const message = await this.messageRepo.findOne({
      where: { id, projectId },
    });
    if (!message) {
      throw new NotFoundException('In-app message not found');
    }
    return message;
  }

  /**
   * An edit is a draft change and is not logged, except that one which moves the
   * message to active or paused writes the same entry as activate or pause, and one
   * which moves an active message to any other status writes `.paused` with `to`.
   */
  async update(
    id: string,
    projectId: string,
    dto: UpdateInAppMessageDto,
    requester: ActivityRequester,
  ): Promise<InAppMessageEntity> {
    return this.changeLocked(id, projectId, requester, (message) => {
      // Prevent editing active campaigns (except pausing/status changes)
      if (message.status === 'active' && dto.status === undefined) {
        // Allow updating content on active campaigns, but log a warning
        this.logger.warn(`Updating active in-app message ${id}`);
      }

      Object.assign(message, {
        ...dto,
        startsAt: dto.startsAt ? new Date(dto.startsAt) : message.startsAt,
        endsAt: dto.endsAt ? new Date(dto.endsAt) : message.endsAt,
      });
    });
  }

  async remove(id: string, projectId: string, requester: ActivityRequester): Promise<void> {
    const message = await this.findOne(id, projectId);
    if (message.status === 'active') {
      throw new BadRequestException('Cannot delete an active message. Pause it first.');
    }
    const entry = contentDeleted(projectId, 'in_app_message', { id: message.id, name: message.name });
    await this.messageRepo.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(InAppMessageEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('In-app message not found');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  async activate(id: string, projectId: string, requester: ActivityRequester): Promise<InAppMessageEntity> {
    return this.changeLocked(id, projectId, requester, (message) => {
      if (!message.title) {
        throw new BadRequestException('Message must have a title before activation');
      }
      message.status = 'active';
    });
  }

  async pause(id: string, projectId: string, requester: ActivityRequester): Promise<InAppMessageEntity> {
    return this.changeLocked(id, projectId, requester, (message) => {
      message.status = 'paused';
    });
  }

  /**
   * Reads the message under a row lock, applies `change`, saves it and, when its
   * status moved to active or paused, writes `in_app_message.activated` or `.paused`,
   * all in one transaction. Activating an active message (or pausing a paused one)
   * changes nothing and writes nothing. An edit that moves an active message to any
   * other status (archived, completed, draft, scheduled) takes it off the air too, so
   * it writes `.paused` with `to`.
   *
   * The lock makes concurrent changes to one message take turns: the second request
   * reads the status the first one committed. So a double click logs once, and an
   * activation racing an archive can never overwrite it unlogged; whichever runs
   * second is judged, and logged, against the status the first one left.
   */
  private changeLocked(
    id: string,
    projectId: string,
    requester: ActivityRequester,
    change: (message: InAppMessageEntity) => void,
  ): Promise<InAppMessageEntity> {
    return this.messageRepo.manager.transaction(async (manager: EntityManager) => {
      const messages = manager.getRepository(InAppMessageEntity);
      const message = await messages.findOne({
        where: { id, projectId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!message) throw new NotFoundException('In-app message not found');
      const before: MessageStatus = message.status;
      change(message);
      const to = message.status;
      const action =
        to === before
          ? null
          : to === 'active'
            ? ('in_app_message.activated' as const)
            : to === 'paused' || before === 'active'
              ? ('in_app_message.paused' as const)
              : null;
      const saved = await messages.save(message);
      if (action) {
        await recordBy(
          this.activity,
          requester,
          {
            projectId: saved.projectId,
            action,
            target: { type: 'in_app_message', id: saved.id, label: saved.name },
            ...(action === 'in_app_message.paused' && to !== 'paused' ? { details: { to } } : {}),
          },
          manager,
        );
      }
      return saved;
    });
  }

  async duplicate(id: string, projectId: string): Promise<InAppMessageEntity> {
    const original = await this.findOne(id, projectId);

    const { id: _id, createdAt, updatedAt, totalImpressions, totalClicks, totalDismissals, ...rest } = original;

    const duplicate = this.messageRepo.create({
      ...rest,
      name: `${original.name} (Copy)`,
      status: 'draft' as MessageStatus,
      totalImpressions: 0,
      totalClicks: 0,
      totalDismissals: 0,
    });

    return this.messageRepo.save(duplicate);
  }

  async incrementCounter(
    id: string,
    counter: 'totalImpressions' | 'totalClicks' | 'totalDismissals',
  ): Promise<void> {
    const columnMap = {
      totalImpressions: 'total_impressions',
      totalClicks: 'total_clicks',
      totalDismissals: 'total_dismissals',
    };

    await this.messageRepo
      .createQueryBuilder()
      .update(InAppMessageEntity)
      .set({ [counter]: () => `${columnMap[counter]} + 1` })
      .where('id = :id', { id })
      .execute();
  }
}
