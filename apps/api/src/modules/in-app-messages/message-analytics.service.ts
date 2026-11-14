import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dateTruncUnit } from '../../common/date-trunc-unit';
import { InAppMessageImpressionEntity } from './entities/in-app-message-impression.entity';
import { InAppMessageEntity } from './entities/in-app-message.entity';

export interface MessageAnalyticsSummary {
  messageId: string;
  totalDelivered: number;
  totalImpressions: number;
  totalClicks: number;
  totalCtaClicks: number;
  totalDismissals: number;
  totalAutoDismissals: number;
  uniqueUsers: number;
  clickRate: number;
  dismissRate: number;
}

export interface MessageFunnel {
  delivered: number;
  impressions: number;
  clicks: number;
  ctaClicks: number;
  dismissals: number;
}

export interface ButtonClickBreakdown {
  buttonId: string;
  clicks: number;
}

export interface TimeSeries {
  date: string;
  impressions: number;
  clicks: number;
  dismissals: number;
}

@Injectable()
export class MessageAnalyticsService {
  private readonly logger = new Logger(MessageAnalyticsService.name);

  constructor(
    @InjectRepository(InAppMessageImpressionEntity)
    private readonly impressionRepo: Repository<InAppMessageImpressionEntity>,
    @InjectRepository(InAppMessageEntity)
    private readonly messageRepo: Repository<InAppMessageEntity>,
  ) {}

  async getSummary(messageId: string, projectId: string): Promise<MessageAnalyticsSummary> {
    const eventCounts = await this.impressionRepo
      .createQueryBuilder('imp')
      .select('imp.event_type', 'eventType')
      .addSelect('COUNT(*)::int', 'count')
      .where('imp.message_id = :messageId', { messageId })
      .andWhere('imp.project_id = :projectId', { projectId })
      .groupBy('imp.event_type')
      .getRawMany();

    const uniqueUsers = await this.impressionRepo
      .createQueryBuilder('imp')
      .select('COUNT(DISTINCT imp.device_fingerprint)::int', 'count')
      .where('imp.message_id = :messageId', { messageId })
      .andWhere('imp.project_id = :projectId', { projectId })
      .getRawOne();

    const counts: Record<string, number> = {};
    for (const row of eventCounts) {
      counts[row.eventType] = parseInt(row.count, 10);
    }

    const totalImpressions = counts['impression'] || 0;
    const totalClicks = counts['click'] || 0;
    const totalCtaClicks = counts['cta_click'] || 0;
    const totalDismissals = counts['dismiss'] || 0;

    return {
      messageId,
      totalDelivered: counts['delivered'] || 0,
      totalImpressions,
      totalClicks,
      totalCtaClicks,
      totalDismissals,
      totalAutoDismissals: counts['auto_dismiss'] || 0,
      uniqueUsers: parseInt(uniqueUsers?.count || '0', 10),
      clickRate: totalImpressions > 0 ? (totalClicks + totalCtaClicks) / totalImpressions : 0,
      dismissRate: totalImpressions > 0 ? totalDismissals / totalImpressions : 0,
    };
  }

  async getFunnel(messageId: string, projectId: string): Promise<MessageFunnel> {
    const summary = await this.getSummary(messageId, projectId);
    return {
      delivered: summary.totalDelivered,
      impressions: summary.totalImpressions,
      clicks: summary.totalClicks,
      ctaClicks: summary.totalCtaClicks,
      dismissals: summary.totalDismissals,
    };
  }

  async getButtonBreakdown(messageId: string, projectId: string): Promise<ButtonClickBreakdown[]> {
    return this.impressionRepo
      .createQueryBuilder('imp')
      .select('imp.button_id', 'buttonId')
      .addSelect('COUNT(*)::int', 'clicks')
      .where('imp.message_id = :messageId', { messageId })
      .andWhere('imp.project_id = :projectId', { projectId })
      .andWhere('imp.event_type = :type', { type: 'cta_click' })
      .andWhere('imp.button_id IS NOT NULL')
      .groupBy('imp.button_id')
      .orderBy('clicks', 'DESC')
      .getRawMany();
  }

  async getTimeseries(
    messageId: string,
    projectId: string,
    opts: { start?: string; end?: string; granularity?: 'hour' | 'day' | 'week' },
  ): Promise<TimeSeries[]> {
    const gran = dateTruncUnit(opts.granularity);
    const now = new Date();
    const start = opts.start ? new Date(opts.start) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const end = opts.end ? new Date(opts.end) : now;

    const rows = await this.impressionRepo
      .createQueryBuilder('imp')
      .select(`DATE_TRUNC('${gran}', imp.created_at)`, 'date')
      .addSelect('imp.event_type', 'eventType')
      .addSelect('COUNT(*)::int', 'count')
      .where('imp.message_id = :messageId', { messageId })
      .andWhere('imp.project_id = :projectId', { projectId })
      .andWhere('imp.event_type IN (:...types)', { types: ['impression', 'click', 'cta_click', 'dismiss'] })
      .andWhere('imp.created_at >= :start', { start })
      .andWhere('imp.created_at <= :end', { end })
      .groupBy(`DATE_TRUNC('${gran}', imp.created_at)`)
      .addGroupBy('imp.event_type')
      .orderBy('date', 'ASC')
      .getRawMany();

    // Pivot the data
    const dateMap = new Map<string, TimeSeries>();

    for (const row of rows) {
      const dateStr = row.date;
      if (!dateMap.has(dateStr)) {
        dateMap.set(dateStr, { date: dateStr, impressions: 0, clicks: 0, dismissals: 0 });
      }
      const entry = dateMap.get(dateStr)!;
      const count = parseInt(row.count, 10);

      switch (row.eventType) {
        case 'impression':
          entry.impressions += count;
          break;
        case 'click':
        case 'cta_click':
          entry.clicks += count;
          break;
        case 'dismiss':
          entry.dismissals += count;
          break;
      }
    }

    return Array.from(dateMap.values());
  }

  async getPlatformBreakdown(
    messageId: string,
    projectId: string,
  ): Promise<{ platform: string; count: number }[]> {
    return this.impressionRepo
      .createQueryBuilder('imp')
      .select('imp.platform', 'platform')
      .addSelect('COUNT(*)::int', 'count')
      .where('imp.message_id = :messageId', { messageId })
      .andWhere('imp.project_id = :projectId', { projectId })
      .andWhere('imp.event_type = :type', { type: 'impression' })
      .andWhere('imp.platform IS NOT NULL')
      .groupBy('imp.platform')
      .orderBy('count', 'DESC')
      .getRawMany();
  }

  async getProjectSummary(
    projectId: string,
  ): Promise<{
    totalCampaigns: number;
    activeCampaigns: number;
    totalImpressions: number;
    totalClicks: number;
    avgClickRate: number;
  }> {
    const [totalCampaigns, activeCampaigns] = await Promise.all([
      this.messageRepo.count({ where: { projectId } }),
      this.messageRepo.count({ where: { projectId, status: 'active' } }),
    ]);

    const stats = await this.messageRepo
      .createQueryBuilder('msg')
      .select('SUM(msg.total_impressions)::int', 'totalImpressions')
      .addSelect('SUM(msg.total_clicks)::int', 'totalClicks')
      .where('msg.project_id = :projectId', { projectId })
      .getRawOne();

    const totalImpressions = parseInt(stats?.totalImpressions || '0', 10);
    const totalClicks = parseInt(stats?.totalClicks || '0', 10);

    return {
      totalCampaigns,
      activeCampaigns,
      totalImpressions,
      totalClicks,
      avgClickRate: totalImpressions > 0 ? totalClicks / totalImpressions : 0,
    };
  }
}
