import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LinkVariantEntity } from './entities/link-variant.entity';
import { CreateLinkVariantDto } from './dto/create-link-variant.dto';
import { UpdateLinkVariantDto } from './dto/update-link-variant.dto';
import { LinkEntity } from './entities/link.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { recordBy, type ActivityRequester } from '../project-activity/messaging-activity';
import { changedLinkFields, linkChanged, VARIANT_FIELDS, type VariantChange } from './link-activity';
import type { EntityManager } from 'typeorm';

@Injectable()
export class LinkVariantsService {
  constructor(
    @InjectRepository(LinkVariantEntity)
    private readonly variantRepository: Repository<LinkVariantEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  /**
   * Writes `link.changed` for a variant in the caller's transaction, naming the link as
   * it is now and the variant by name (else id), never by URL.
   */
  private async recordVariantChange(
    manager: EntityManager,
    projectId: string,
    linkId: string,
    change: { change: VariantChange; fields?: string[]; variant: { id: string; name?: string | null } },
    requester: ActivityRequester,
  ): Promise<void> {
    const link = await manager.getRepository(LinkEntity).findOne({
      where: { id: linkId, projectId },
      select: { id: true, title: true, shortCode: true },
    });
    if (!link) throw new NotFoundException('Link not found');
    await recordBy(this.activity, requester, linkChanged(projectId, link, change), manager);
  }

  /** Every variant write below logs in its own transaction; `projectId` is the guard's. */
  async create(
    linkId: string,
    dto: CreateLinkVariantDto,
    projectId: string,
    requester: ActivityRequester,
  ): Promise<LinkVariantEntity> {
    const variant = this.variantRepository.create({
      linkId,
      name: dto.name,
      longUrl: dto.longUrl,
      iosUrl: dto.iosUrl || null,
      androidUrl: dto.androidUrl || null,
      weight: dto.weight ?? 50,
    } as Partial<LinkVariantEntity>);
    const fields = VARIANT_FIELDS.filter((key) => (dto as unknown as Record<string, unknown>)[key] != null);
    return this.variantRepository.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(LinkVariantEntity).save(variant as LinkVariantEntity);
      await this.recordVariantChange(manager, projectId, linkId, { change: 'added', fields, variant: saved }, requester);
      return saved;
    });
  }

  async findAllByLink(linkId: string): Promise<LinkVariantEntity[]> {
    return this.variantRepository.find({
      where: { linkId },
      order: { createdAt: 'ASC' },
    });
  }

  async update(
    id: string,
    linkId: string,
    dto: UpdateLinkVariantDto,
    projectId: string,
    requester: ActivityRequester,
  ): Promise<LinkVariantEntity> {
    const variant = await this.variantRepository.findOne({ where: { id, linkId } });
    if (!variant) {
      throw new NotFoundException('Variant not found');
    }
    const fields = changedLinkFields(variant, dto, VARIANT_FIELDS);
    // Only the variant's own editable fields, never the raw body: the DTO already
    // refuses other keys, and this holds even if a caller bypasses it.
    const body = dto as Record<string, unknown>;
    for (const key of VARIANT_FIELDS) {
      if (body[key] !== undefined) (variant as unknown as Record<string, unknown>)[key] = body[key];
    }
    if (fields.length === 0) return this.variantRepository.save(variant);
    return this.variantRepository.manager.transaction(async (manager) => {
      const saved = await manager.getRepository(LinkVariantEntity).save(variant);
      await this.recordVariantChange(manager, projectId, linkId, { change: 'changed', fields, variant: saved }, requester);
      return saved;
    });
  }

  async remove(id: string, linkId: string, projectId: string, requester: ActivityRequester): Promise<void> {
    const variant = await this.variantRepository.findOne({ where: { id, linkId } });
    if (!variant) {
      throw new NotFoundException('Variant not found');
    }
    const named = { id: variant.id, name: variant.name };
    await this.variantRepository.manager.transaction(async (manager) => {
      await manager.getRepository(LinkVariantEntity).remove(variant);
      await this.recordVariantChange(manager, projectId, linkId, { change: 'removed', variant: named }, requester);
    });
  }

  async selectVariant(linkId: string): Promise<LinkVariantEntity | null> {
    const variants = await this.variantRepository.find({ where: { linkId } });
    if (variants.length === 0) return null;

    const totalWeight = variants.reduce((sum, v) => sum + v.weight, 0);
    if (totalWeight === 0) return variants[0];

    let random = Math.random() * totalWeight;
    for (const variant of variants) {
      random -= variant.weight;
      if (random <= 0) {
        variant.clicks++;
        await this.variantRepository.save(variant);
        return variant;
      }
    }
    return variants[variants.length - 1];
  }
}
