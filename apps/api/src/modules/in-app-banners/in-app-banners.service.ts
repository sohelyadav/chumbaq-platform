import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThanOrEqual, MoreThanOrEqual, IsNull, Or, DataSource, In } from 'typeorm';
import * as geoip from 'geoip-lite';
import { InAppBannerEntity } from './entities/in-app-banner.entity';
import { BannerCategoryEntity } from './entities/banner-category.entity';
import { WidgetEventEntity } from './entities/widget-event.entity';
import { CreateInAppBannerDto } from './dto/create-in-app-banner.dto';
import { UpdateInAppBannerDto } from './dto/update-in-app-banner.dto';
import { ReorderItemDto } from './dto/reorder-banners.dto';
import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { contentDeleted, recordBy, type ActivityRequester } from '../project-activity/messaging-activity';

@Injectable()
export class InAppBannersService {
  constructor(
    @InjectRepository(InAppBannerEntity)
    private readonly bannerRepository: Repository<InAppBannerEntity>,
    @InjectRepository(BannerCategoryEntity)
    private readonly categoryRepository: Repository<BannerCategoryEntity>,
    @InjectRepository(WidgetEventEntity)
    private readonly eventRepository: Repository<WidgetEventEntity>,
    private readonly dataSource: DataSource,
    private readonly suspension: ProjectSuspensionService,
    private readonly activity: ProjectActivityService,
  ) {}

  async create(categoryId: string, dto: CreateInAppBannerDto): Promise<InAppBannerEntity> {
    const banner = this.bannerRepository.create({ ...dto, categoryId });
    return this.bannerRepository.save(banner);
  }

  async findAllByCategory(categoryId: string): Promise<InAppBannerEntity[]> {
    return this.bannerRepository.find({
      where: { categoryId },
      order: { sortOrder: 'ASC', createdAt: 'DESC' },
    });
  }

  async findOne(id: string): Promise<InAppBannerEntity> {
    const banner = await this.bannerRepository.findOne({ where: { id } });
    if (!banner) {
      throw new NotFoundException('In-app banner not found');
    }
    return banner;
  }

  async update(id: string, dto: UpdateInAppBannerDto): Promise<InAppBannerEntity> {
    const banner = await this.findOne(id);
    Object.assign(banner, dto);
    return this.bannerRepository.save(banner);
  }

  /** `projectId` is the one the route's guard resolved the banner to. */
  async remove(id: string, projectId: string, requester: ActivityRequester): Promise<void> {
    const banner = await this.findOne(id);
    const entry = contentDeleted(projectId, 'banner', { id: banner.id, name: banner.title });
    await this.bannerRepository.manager.transaction(async (manager) => {
      // Only the request whose DELETE removed the row writes the entry.
      const result = await manager.getRepository(InAppBannerEntity).delete({ id, categoryId: banner.categoryId });
      if (!result.affected) throw new NotFoundException('In-app banner not found');
      await recordBy(this.activity, requester, entry, manager);
    });
  }

  async reorder(categoryId: string, items: ReorderItemDto[]): Promise<void> {
    // Validate all items belong to this category
    const itemIds = items.map((i) => i.id);
    const banners = await this.bannerRepository.find({
      where: { id: In(itemIds), categoryId },
    });
    if (banners.length !== items.length) {
      throw new NotFoundException('Some banner IDs do not belong to this category');
    }

    // Use transaction for atomicity
    await this.dataSource.transaction(async (manager) => {
      for (const item of items) {
        await manager.update(InAppBannerEntity, { id: item.id, categoryId }, { sortOrder: item.sortOrder });
      }
    });
  }

  async serve(
    categoryId: string,
    context?: { ipAddress?: string; userAgent?: string; referrer?: string },
  ): Promise<{ category: BannerCategoryEntity; banners: InAppBannerEntity[] }> {
    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, status: 'active' },
    });
    if (!category) {
      throw new NotFoundException('Widget not found or not active');
    }

    const now = new Date();
    const banners = await this.bannerRepository.find({
      where: {
        categoryId,
        isActive: true,
        startsAt: Or(IsNull(), LessThanOrEqual(now)),
        expiresAt: Or(IsNull(), MoreThanOrEqual(now)),
      },
      order: { sortOrder: 'ASC' },
    });

    // Record impression events fire-and-forget
    if (banners.length > 0) {
      this.recordEvents(banners, categoryId, 'impression', context).catch(() => {});
    }

    return { category, banners };
  }

  async recordClick(
    bannerId: string,
    context?: { ipAddress?: string; userAgent?: string; referrer?: string },
    expectedProjectId?: string,
  ): Promise<void> {
    const banner = await this.findOne(bannerId);

    // Verify the banner belongs to the API key's project, otherwise an
    // attacker with any valid API key could inflate any project's metrics.
    if (expectedProjectId) {
      const category = await this.categoryRepository.findOne({
        where: { id: banner.categoryId },
      });
      if (!category || category.projectId !== expectedProjectId) {
        throw new NotFoundException('In-app banner not found');
      }
    }

    // Record click event
    this.recordEvents([banner], banner.categoryId, 'click', context).catch(() => {});

    // Update denormalized counter
    await this.bannerRepository
      .createQueryBuilder()
      .update(InAppBannerEntity)
      .set({ clicks: () => 'clicks + 1' })
      .where('id = :id', { id: banner.id })
      .execute();
  }

  async serveScoped(
    categoryId: string,
    expectedProjectId: string,
    context?: { ipAddress?: string; userAgent?: string; referrer?: string },
  ): Promise<{ category: BannerCategoryEntity; banners: InAppBannerEntity[] }> {
    const category = await this.categoryRepository.findOne({
      where: { id: categoryId, status: 'active' },
    });
    if (!category || category.projectId !== expectedProjectId) {
      throw new NotFoundException('Widget not found or not active');
    }
    // Banners are the tenant's content going out to its users, so they stop like
    // in-app messages do. Answered as a widget with nothing live in it, the shape
    // the SDK already handles, rather than the 404 above, which SDK clients would
    // treat as terminal. No impression is recorded.
    if (await this.suspension.isSuspended(expectedProjectId)) {
      return { category, banners: [] };
    }
    return this.serve(categoryId, context);
  }

  private async recordEvents(
    banners: InAppBannerEntity[],
    categoryId: string,
    eventType: string,
    context?: { ipAddress?: string; userAgent?: string; referrer?: string },
  ): Promise<void> {
    let geo: { country?: string; countryCode?: string; city?: string } = {};

    if (context?.ipAddress) {
      const ip = context.ipAddress;
      const isLocal = !ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('192.168.') || ip.startsWith('10.');
      const lookup = isLocal ? null : geoip.lookup(ip);
      if (lookup) {
        geo = { country: lookup.country, countryCode: lookup.country, city: lookup.city };
      }
    }

    // Parse user agent for platform/device/os/browser (simple extraction)
    const ua = context?.userAgent || '';
    const platform = /mobile/i.test(ua) ? 'mobile' : /tablet/i.test(ua) ? 'tablet' : 'desktop';
    const deviceType = platform;
    const os = /android/i.test(ua) ? 'Android' : /iphone|ipad|mac/i.test(ua) ? 'iOS' : /windows/i.test(ua) ? 'Windows' : /linux/i.test(ua) ? 'Linux' : null;
    const browser = /chrome/i.test(ua) ? 'Chrome' : /firefox/i.test(ua) ? 'Firefox' : /safari/i.test(ua) ? 'Safari' : /edge/i.test(ua) ? 'Edge' : null;

    const events = banners.map((banner) =>
      this.eventRepository.create({
        bannerId: banner.id,
        categoryId,
        eventType,
        ipAddress: context?.ipAddress || undefined,
        userAgent: context?.userAgent || undefined,
        referrer: context?.referrer || undefined,
        platform,
        deviceType,
        os: os || undefined,
        browser: browser || undefined,
        country: geo.country || undefined,
        countryCode: geo.countryCode || undefined,
        city: geo.city || undefined,
      }),
    );

    await this.eventRepository.save(events);

    // Update denormalized impression counters
    if (eventType === 'impression') {
      const ids = banners.map((b) => b.id);
      await this.bannerRepository
        .createQueryBuilder()
        .update(InAppBannerEntity)
        .set({ impressions: () => 'impressions + 1' })
        .whereInIds(ids)
        .execute();
    }
  }
}
