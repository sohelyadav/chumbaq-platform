import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Between, MoreThanOrEqual } from 'typeorm';
import { TouchpointEntity, TouchpointType } from './entities/touchpoint.entity';

export interface RecordTouchpointParams {
  projectId: string;
  distinctId?: string;
  deviceFingerprint?: string;
  touchpointType: TouchpointType;
  channel?: string;
  campaign?: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  utmTerm?: string;
  utmContent?: string;
  linkId?: string;
  sourceEventId?: string;
  referrer?: string;
  platform?: string;
  deviceType?: string;
  country?: string;
  city?: string;
  ipAddress?: string;
  metadata?: Record<string, any>;
}

@Injectable()
export class TouchpointsService {
  private readonly logger = new Logger(TouchpointsService.name);

  constructor(
    @InjectRepository(TouchpointEntity)
    private readonly touchpointRepository: Repository<TouchpointEntity>,
  ) {}

  async record(params: RecordTouchpointParams): Promise<TouchpointEntity> {
    const touchpoint = this.touchpointRepository.create({
      projectId: params.projectId,
      distinctId: params.distinctId || null,
      deviceFingerprint: params.deviceFingerprint || null,
      touchpointType: params.touchpointType,
      channel: params.channel || this.inferChannel(params),
      campaign: params.campaign || params.utmCampaign || null,
      utmSource: params.utmSource || null,
      utmMedium: params.utmMedium || null,
      utmCampaign: params.utmCampaign || null,
      utmTerm: params.utmTerm || null,
      utmContent: params.utmContent || null,
      linkId: params.linkId || null,
      sourceEventId: params.sourceEventId || null,
      referrer: params.referrer || null,
      platform: params.platform || null,
      deviceType: params.deviceType || null,
      country: params.country || null,
      city: params.city || null,
      ipAddress: params.ipAddress || null,
      metadata: params.metadata || null,
    } as Partial<TouchpointEntity>);

    return this.touchpointRepository.save(touchpoint as TouchpointEntity);
  }

  async getJourney(
    projectId: string,
    distinctId: string,
    lookbackDays = 30,
  ): Promise<TouchpointEntity[]> {
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);

    return this.touchpointRepository.find({
      where: {
        projectId,
        distinctId,
        touchedAt: MoreThanOrEqual(since),
      },
      order: { touchedAt: 'ASC' },
    });
  }

  async getJourneyByFingerprint(
    projectId: string,
    deviceFingerprint: string,
    lookbackDays = 30,
  ): Promise<TouchpointEntity[]> {
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);

    return this.touchpointRepository.find({
      where: {
        projectId,
        deviceFingerprint,
        touchedAt: MoreThanOrEqual(since),
      },
      order: { touchedAt: 'ASC' },
    });
  }

  async getJourneyBeforeConversion(
    projectId: string,
    distinctId: string,
    conversionTime: Date,
    lookbackDays = 30,
  ): Promise<TouchpointEntity[]> {
    const since = new Date(conversionTime.getTime() - lookbackDays * 24 * 60 * 60 * 1000);

    return this.touchpointRepository.find({
      where: {
        projectId,
        distinctId,
        touchedAt: Between(since, conversionTime),
      },
      order: { touchedAt: 'ASC' },
    });
  }

  async getChannelSummary(
    projectId: string,
    start?: Date,
    end?: Date,
  ): Promise<{ channel: string; count: number; percentage: number }[]> {
    const qb = this.touchpointRepository
      .createQueryBuilder('tp')
      .select('tp.channel', 'channel')
      .addSelect('COUNT(*)::int', 'count')
      .where('tp.project_id = :projectId', { projectId })
      .andWhere('tp.channel IS NOT NULL');

    if (start) qb.andWhere('tp.touched_at >= :start', { start });
    if (end) qb.andWhere('tp.touched_at <= :end', { end });

    const results = await qb
      .groupBy('tp.channel')
      .orderBy('count', 'DESC')
      .getRawMany();

    const total = results.reduce((sum, row) => sum + Number(row.count), 0);
    return results.map(row => ({
      channel: row.channel,
      count: Number(row.count),
      percentage: total > 0 ? (Number(row.count) / total) * 100 : 0,
    }));
  }

  private inferChannel(params: RecordTouchpointParams): string | null {
    if (params.utmSource) return params.utmSource;
    if (params.touchpointType === 'push_click') return 'push';
    if (params.touchpointType === 'email_open') return 'email';
    if (params.touchpointType === 'banner_view' || params.touchpointType === 'banner_click') return 'in-app';
    if (params.referrer) {
      const ref = params.referrer.toLowerCase();
      if (ref.includes('facebook') || ref.includes('fb.com')) return 'facebook';
      if (ref.includes('google')) return 'google';
      if (ref.includes('twitter') || ref.includes('t.co')) return 'twitter';
      if (ref.includes('instagram')) return 'instagram';
      if (ref.includes('youtube')) return 'youtube';
      if (ref.includes('linkedin')) return 'linkedin';
      return 'referral';
    }
    if (params.touchpointType === 'link_click') return 'direct';
    return null;
  }
}
