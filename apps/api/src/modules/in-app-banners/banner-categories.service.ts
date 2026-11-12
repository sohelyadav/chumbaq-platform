import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { BannerCategoryEntity } from './entities/banner-category.entity';
import { CreateBannerCategoryDto } from './dto/create-banner-category.dto';
import { UpdateBannerCategoryDto } from './dto/update-banner-category.dto';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

@Injectable()
export class BannerCategoriesService {
  constructor(
    @InjectRepository(BannerCategoryEntity)
    private readonly categoryRepository: Repository<BannerCategoryEntity>,
    private readonly activity: ProjectActivityService,
  ) {}

  async create(projectId: string, dto: CreateBannerCategoryDto): Promise<BannerCategoryEntity> {
    const category = this.categoryRepository.create({ ...dto, projectId });
    return this.categoryRepository.save(category);
  }

  async findAllByProject(
    projectId: string,
    layout?: string,
  ): Promise<(BannerCategoryEntity & { bannerCount: number; totalImpressions: number; totalClicks: number })[]> {
    const qb = this.categoryRepository
      .createQueryBuilder('category')
      .leftJoin('category.banners', 'banner')
      .leftJoin('widget_events', 'we', 'we.category_id = category.id')
      .addSelect('COUNT(DISTINCT banner.id)', 'bannerCount')
      .addSelect(`COALESCE(SUM(CASE WHEN we.event_type = 'impression' THEN 1 ELSE 0 END), 0)`, 'totalImpressions')
      .addSelect(`COALESCE(SUM(CASE WHEN we.event_type = 'click' THEN 1 ELSE 0 END), 0)`, 'totalClicks')
      .where('category.projectId = :projectId', { projectId })
      .groupBy('category.id')
      .orderBy('category.createdAt', 'DESC');

    if (layout) {
      qb.andWhere('category.layout = :layout', { layout });
    }

    const result = await qb.getRawAndEntities();

    return result.entities.map((entity, index) => ({
      ...entity,
      bannerCount: parseInt(result.raw[index].bannerCount || '0', 10),
      totalImpressions: parseInt(result.raw[index].totalImpressions || '0', 10),
      totalClicks: parseInt(result.raw[index].totalClicks || '0', 10),
    }));
  }

  async findOne(id: string): Promise<BannerCategoryEntity> {
    const category = await this.categoryRepository.findOne({ where: { id } });
    if (!category) {
      throw new NotFoundException('Banner category not found');
    }
    return category;
  }

  async findOneWithBanners(id: string): Promise<BannerCategoryEntity> {
    const category = await this.categoryRepository.findOne({
      where: { id },
      relations: ['banners'],
      order: { banners: { sortOrder: 'ASC' } },
    });
    if (!category) {
      throw new NotFoundException('Banner category not found');
    }
    return category;
  }

  async update(id: string, dto: UpdateBannerCategoryDto): Promise<BannerCategoryEntity> {
    const category = await this.findOne(id);
    Object.assign(category, dto);
    return this.categoryRepository.save(category);
  }

  async updateStatus(id: string, status: string): Promise<BannerCategoryEntity> {
    const category = await this.findOne(id);
    category.status = status;
    return this.categoryRepository.save(category);
  }

  /** `projectId` is the one the route's guard resolved the category to. */
  async remove(id: string, projectId: string, requester: ActivityRequester): Promise<void> {
    const category = await this.findOne(id);
    const entry = contentDeleted(projectId, 'banner_category', { id: category.id, name: category.name });
    await this.categoryRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(BannerCategoryEntity).delete({ id, projectId });
      if (!result.affected) throw new NotFoundException('Banner category not found');
      await recordBy(this.activity, requester, entry, manager);
    });
  }
}
