import {
  ConflictException,
  Injectable,
  NotFoundException,
  InternalServerErrorException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { nanoid } from 'nanoid';
import { LinkEntity } from './entities/link.entity';
import { CreateLinkDto } from './dto/create-link.dto';
import { UpdateLinkDto } from './dto/update-link.dto';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { changedLinkFields, linkChanged } from './link-activity';

// Slugs that would collide with API routes, well-known paths, or common
// frontend routes. Checked case-insensitively.
const RESERVED_SHORT_CODES = new Set([
  'api',
  // GET /api/health, the deploy scripts' health check (/redirect/health would reach it).
  'health',
  'admin',
  // The customer app's view-as handoff page.
  'impersonate',
  // The customer app's invitation page (`/invite#token=...`).
  'invite',
  'www',
  'app',
  'auth',
  'login',
  'logout',
  'signup',
  'register',
  'dashboard',
  'settings',
  'help',
  'support',
  'about',
  'terms',
  'privacy',
  'contact',
  'docs',
  'static',
  'assets',
  'public',
  'projects',
  'links',
  'well-known',
  'verify-email',
  'forgot-password',
  'reset-password',
  // `/account/cancel-support-link`, the button in the staff reset link notice.
  'account',
]);

@Injectable()
export class LinksService {
  constructor(
    @InjectRepository(LinkEntity)
    private readonly linkRepository: Repository<LinkEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  async create(
    projectId: string,
    dto: CreateLinkDto,
  ): Promise<LinkEntity> {
    const { shortCode: customShortCode, ...linkData } = dto;
    const shortCode = customShortCode
      ? await this.claimCustomShortCode(customShortCode)
      : await this.generateUniqueShortCode();

    const link = this.linkRepository.create({
      ...linkData,
      shortCode,
      projectId,
    });

    try {
      return await this.linkRepository.save(link);
    } catch (err) {
      // Race: another request may have claimed the same custom slug between
      // our existence check and the insert. The unique index on short_code
      // catches it — translate to 409 so the client sees the same error as
      // the pre-check path.
      if (customShortCode && this.isUniqueViolation(err)) {
        throw new ConflictException(
          `Short code "${customShortCode}" is already taken`,
        );
      }
      throw err;
    }
  }

  async findAllByProject(
    projectId: string,
    pagination: PaginationDto,
    search?: string,
    tags?: string,
  ): Promise<{
    data: LinkEntity[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }> {
    const qb = this.linkRepository
      .createQueryBuilder('link')
      .loadRelationCountAndMap('link.clickCount', 'link.clickEvents')
      .where('link.projectId = :projectId', { projectId })
      .orderBy('link.createdAt', 'DESC')
      .skip(pagination.skip)
      .take(pagination.limit);

    if (search) {
      qb.andWhere('link.title ILIKE :search', { search: `%${search}%` });
    }

    if (tags) {
      const tagList = tags.split(',').map((t) => t.trim());
      for (let i = 0; i < tagList.length; i++) {
        qb.andWhere('link.tags LIKE :tag' + i, {
          ['tag' + i]: `%${tagList[i]}%`,
        });
      }
    }

    const [data, total] = await qb.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page: pagination.page,
        limit: pagination.limit,
        totalPages: Math.ceil(total / pagination.limit),
      },
    };
  }

  async findOne(id: string): Promise<LinkEntity> {
    const link = await this.linkRepository.findOne({
      where: { id },
      relations: ['project'],
    });
    if (!link) {
      throw new NotFoundException('Link not found');
    }
    return link;
  }

  async findByShortCode(shortCode: string): Promise<LinkEntity> {
    const link = await this.linkRepository.findOne({
      where: { shortCode },
      relations: ['project'],
    });
    if (!link) {
      throw new NotFoundException('Link not found');
    }
    return link;
  }

  /**
   * Logs `link.changed` with the names of the fields that really change, in the same
   * transaction; an edit that changes nothing writes nothing. `projectId` is the one the
   * route's guard resolved the link to.
   */
  async update(
    id: string,
    dto: UpdateLinkDto,
    projectId: string,
    requester: ActivityRequester,
  ): Promise<LinkEntity> {
    const link = await this.findOne(id);
    // The ValidationPipe whitelists the body, so its keys are `UpdateLinkDto`'s.
    const fields = changedLinkFields(link, dto, Object.keys(dto));
    Object.assign(link, dto);
    if (fields.length === 0) return this.linkRepository.save(link);
    return this.linkRepository.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(LinkEntity).save(link);
      await recordBy(this.activity, requester, linkChanged(projectId, saved, { fields }), manager);
      return saved;
    });
  }

  /** `projectId` is the one the route's guard resolved the link to. */
  async remove(id: string, projectId: string, requester: ActivityRequester): Promise<void> {
    const link = await this.findOne(id);
    const entry = contentDeleted(projectId, 'link', { id: link.id, name: link.title || link.shortCode });
    await this.linkRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(LinkEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('Link not found');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  private async generateUniqueShortCode(maxAttempts = 5): Promise<string> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const shortCode = nanoid(7);
      const existing = await this.linkRepository.findOne({
        where: { shortCode },
      });
      if (!existing) {
        return shortCode;
      }
    }
    throw new InternalServerErrorException(
      'Failed to generate a unique short code after maximum attempts',
    );
  }

  private async claimCustomShortCode(shortCode: string): Promise<string> {
    if (RESERVED_SHORT_CODES.has(shortCode.toLowerCase())) {
      throw new ConflictException(
        `"${shortCode}" is a reserved word and cannot be used as a short code`,
      );
    }
    const existing = await this.linkRepository.findOne({
      where: { shortCode },
    });
    if (existing) {
      throw new ConflictException(
        `Short code "${shortCode}" is already taken`,
      );
    }
    return shortCode;
  }

  private isUniqueViolation(err: unknown): boolean {
    // Postgres unique_violation SQLSTATE
    return (
      err instanceof QueryFailedError &&
      (err as QueryFailedError & { code?: string }).code === '23505'
    );
  }
}
