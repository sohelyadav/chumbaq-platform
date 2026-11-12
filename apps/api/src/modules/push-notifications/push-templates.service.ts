import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { PushTemplateEntity } from './entities/push-template.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import {
  CreatePushTemplateDto,
  UpdatePushTemplateDto,
} from './dto/push-notification.dto';
import { validateCarousel, validateTimer } from './rich-content';

@Injectable()
export class PushTemplatesService {
  constructor(
    @InjectRepository(PushTemplateEntity)
    private readonly templateRepository: Repository<PushTemplateEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  async findAll(projectId: string): Promise<PushTemplateEntity[]> {
    return this.templateRepository.find({
      where: { projectId },
      // Most-used first: a template list is a picker, and the one reached for
      // most often should not be buried under alphabetical order.
      order: { useCount: 'DESC', name: 'ASC' },
    });
  }

  async findOne(projectId: string, id: string): Promise<PushTemplateEntity> {
    const template = await this.templateRepository.findOne({
      where: { id, projectId },
    });
    if (!template) {
      throw new NotFoundException('Template not found for this project');
    }
    return template;
  }

  async create(
    projectId: string,
    dto: CreatePushTemplateDto,
  ): Promise<PushTemplateEntity> {
    await this.assertNameFree(projectId, dto.name);
    this.assertRichContentValid(dto);

    return this.templateRepository.save(
      this.templateRepository.create({
        projectId,
        name: dto.name,
        description: dto.description ?? null,
        title: dto.title,
        body: dto.body ?? null,
        imageUrl: dto.imageUrl ?? null,
        deepLinkUrl: dto.deepLinkUrl ?? null,
        data: dto.data ?? null,
        silent: dto.silent ?? false,
        deliveryOptions: (dto.deliveryOptions ?? null) as never,
        translations: (dto.translations ?? null) as never,
        actions: dto.actions ?? null,
        iosCategory: dto.iosCategory ?? null,
        carousel: dto.carousel ?? null,
        timer: dto.timer ?? null,
      }),
    );
  }

  async update(
    projectId: string,
    id: string,
    dto: UpdatePushTemplateDto,
  ): Promise<PushTemplateEntity> {
    const template = await this.findOne(projectId, id);

    if (dto.name && dto.name !== template.name) {
      await this.assertNameFree(projectId, dto.name);
    }
    this.assertRichContentValid(dto);

    // Assigned field by field rather than spread: a spread would let a client
    // set useCount or lastUsedAt, which are records of what happened, not
    // settings.
    if (dto.name !== undefined) template.name = dto.name;
    if (dto.description !== undefined) template.description = dto.description ?? null;
    if (dto.title !== undefined) template.title = dto.title;
    if (dto.body !== undefined) template.body = dto.body ?? null;
    if (dto.imageUrl !== undefined) template.imageUrl = dto.imageUrl ?? null;
    if (dto.deepLinkUrl !== undefined) template.deepLinkUrl = dto.deepLinkUrl ?? null;
    if (dto.data !== undefined) template.data = dto.data ?? null;
    if (dto.silent !== undefined) template.silent = dto.silent;
    if (dto.deliveryOptions !== undefined) {
      template.deliveryOptions = (dto.deliveryOptions ?? null) as never;
    }
    if (dto.translations !== undefined) {
      template.translations = (dto.translations ?? null) as never;
    }
    if (dto.actions !== undefined) template.actions = dto.actions ?? null;
    if (dto.iosCategory !== undefined) template.iosCategory = dto.iosCategory ?? null;
    if (dto.carousel !== undefined) template.carousel = dto.carousel ?? null;
    if (dto.timer !== undefined) template.timer = dto.timer ?? null;

    return this.templateRepository.save(template);
  }

  async remove(projectId: string, id: string, requester: ActivityRequester): Promise<void> {
    const template = await this.findOne(projectId, id);
    const entry = contentDeleted(projectId, 'template', { id: template.id, name: template.name });
    await this.templateRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(PushTemplateEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('Template not found for this project');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  /**
   * Rejects rich content a template cannot meaningfully hold.
   *
   * The carousel rules are the campaign's own, so a template cannot store
   * something that would be refused the moment a campaign is built from it.
   *
   * Countdowns are stricter here than on a campaign, and deliberately. A
   * campaign's countdown is checked against the instant it will go out; a
   * template has no send time, because the whole point of one is to be used
   * again. A fixed `endsAt` therefore bakes in a moment that will pass, and
   * every campaign started from it afterwards would carry a countdown that is
   * already over. A duration is measured from each send, so it keeps meaning
   * the same thing however often the template is reused.
   */
  private assertRichContentValid(
    dto: CreatePushTemplateDto | UpdatePushTemplateDto,
  ): void {
    if (dto.carousel) {
      const problem = validateCarousel(dto.carousel);
      if (problem) throw new BadRequestException(problem);
    }

    if (dto.timer) {
      if (dto.timer.endsAt) {
        throw new BadRequestException(
          'A template countdown has to be a duration rather than a fixed end '
            + 'time — a fixed moment would pass, and every campaign started '
            + 'from this template afterwards would arrive already expired.',
        );
      }
      // `sendAt` is unused for a duration; passing now keeps the one
      // definition of what a valid countdown is.
      const problem = validateTimer(dto.timer, new Date());
      if (problem) throw new BadRequestException(problem);
    }
  }

  /**
   * Records that a campaign was created from this template.
   *
   * Best-effort and non-blocking for the caller: a usage counter is not worth
   * failing a send over.
   */
  async recordUse(projectId: string, id: string): Promise<void> {
    await this.templateRepository
      .createQueryBuilder()
      .update(PushTemplateEntity)
      .set({ useCount: () => 'use_count + 1', lastUsedAt: new Date() })
      .where('id = :id AND project_id = :projectId', { id, projectId })
      .execute();
  }

  /**
   * Names are unique per project so a picker cannot show two identical
   * entries, which is how the wrong copy gets sent.
   */
  private async assertNameFree(projectId: string, name: string): Promise<void> {
    const existing = await this.templateRepository.findOne({
      where: { projectId, name },
    });
    if (existing) {
      throw new ConflictException(`A template named "${name}" already exists.`);
    }
  }
}
