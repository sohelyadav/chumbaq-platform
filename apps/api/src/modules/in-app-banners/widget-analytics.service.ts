import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dateTruncUnit } from '../../common/date-trunc-unit';
import { WidgetEventEntity } from './entities/widget-event.entity';

@Injectable()
export class WidgetAnalyticsService {
  constructor(
    @InjectRepository(WidgetEventEntity)
    private readonly eventRepository: Repository<WidgetEventEntity>,
  ) {}

  async getSummary(categoryId: string): Promise<{
    totalImpressions: number;
    totalClicks: number;
    ctr: number;
    uniqueVisitors: number;
  }> {
    const [totalImpressions, totalClicks, uniqueResult] = await Promise.all([
      this.eventRepository.count({ where: { categoryId, eventType: 'impression' } }),
      this.eventRepository.count({ where: { categoryId, eventType: 'click' } }),
      this.eventRepository
        .createQueryBuilder('event')
        .select('COUNT(DISTINCT event.ip_address)', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .getRawOne(),
    ]);

    const uniqueVisitors = parseInt(uniqueResult?.count || '0', 10);
    const ctr = totalImpressions > 0 ? totalClicks / totalImpressions : 0;

    return { totalImpressions, totalClicks, ctr, uniqueVisitors };
  }

  async getTimeseries(
    categoryId: string,
    start: Date,
    end: Date,
    granularity: 'hour' | 'day' | 'week' = 'day',
  ): Promise<{ date: string; impressions: number; clicks: number }[]> {
    const gran = dateTruncUnit(granularity);

    const result = await this.eventRepository
      .createQueryBuilder('event')
      .select(`DATE_TRUNC('${gran}', event.created_at)`, 'date')
      .addSelect(`SUM(CASE WHEN event.event_type = 'impression' THEN 1 ELSE 0 END)::int`, 'impressions')
      .addSelect(`SUM(CASE WHEN event.event_type = 'click' THEN 1 ELSE 0 END)::int`, 'clicks')
      .where('event.category_id = :categoryId', { categoryId })
      .andWhere('event.created_at >= :start', { start })
      .andWhere('event.created_at <= :end', { end })
      .groupBy(`DATE_TRUNC('${gran}', event.created_at)`)
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({
      date: r.date,
      impressions: Number(r.impressions),
      clicks: Number(r.clicks),
    }));
  }

  async getDeviceBreakdown(categoryId: string): Promise<{
    deviceTypes: { name: string; count: number }[];
    operatingSystems: { name: string; count: number }[];
    browsers: { name: string; count: number }[];
  }> {
    const [deviceTypes, operatingSystems, browsers] = await Promise.all([
      this.eventRepository
        .createQueryBuilder('event')
        .select('event.device_type', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .andWhere('event.device_type IS NOT NULL')
        .groupBy('event.device_type')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.eventRepository
        .createQueryBuilder('event')
        .select('event.os', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .andWhere('event.os IS NOT NULL')
        .groupBy('event.os')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.eventRepository
        .createQueryBuilder('event')
        .select('event.browser', 'name')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .andWhere('event.browser IS NOT NULL')
        .groupBy('event.browser')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      deviceTypes: deviceTypes.map((d) => ({ name: d.name, count: Number(d.count) })),
      operatingSystems: operatingSystems.map((d) => ({ name: d.name, count: Number(d.count) })),
      browsers: browsers.map((d) => ({ name: d.name, count: Number(d.count) })),
    };
  }

  async getGeoBreakdown(categoryId: string): Promise<{
    countries: { name: string; code: string; count: number }[];
    cities: { name: string; country: string; count: number }[];
  }> {
    const [countries, cities] = await Promise.all([
      this.eventRepository
        .createQueryBuilder('event')
        .select('event.country', 'name')
        .addSelect('event.country_code', 'code')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .andWhere('event.country IS NOT NULL')
        .groupBy('event.country')
        .addGroupBy('event.country_code')
        .orderBy('count', 'DESC')
        .getRawMany(),

      this.eventRepository
        .createQueryBuilder('event')
        .select('event.city', 'name')
        .addSelect('event.country', 'country')
        .addSelect('COUNT(*)::int', 'count')
        .where('event.category_id = :categoryId', { categoryId })
        .andWhere('event.city IS NOT NULL')
        .groupBy('event.city')
        .addGroupBy('event.country')
        .orderBy('count', 'DESC')
        .getRawMany(),
    ]);

    return {
      countries: countries.map((c) => ({ name: c.name, code: c.code, count: Number(c.count) })),
      cities: cities.map((c) => ({ name: c.name, country: c.country, count: Number(c.count) })),
    };
  }

  async getItemStats(categoryId: string): Promise<{
    items: { bannerId: string; title: string; impressions: number; clicks: number; ctr: number }[];
  }> {
    const result = await this.eventRepository
      .createQueryBuilder('event')
      .innerJoin('event.banner', 'banner')
      .select('event.banner_id', 'bannerId')
      .addSelect('banner.title', 'title')
      .addSelect(`SUM(CASE WHEN event.event_type = 'impression' THEN 1 ELSE 0 END)::int`, 'impressions')
      .addSelect(`SUM(CASE WHEN event.event_type = 'click' THEN 1 ELSE 0 END)::int`, 'clicks')
      .where('event.category_id = :categoryId', { categoryId })
      .groupBy('event.banner_id')
      .addGroupBy('banner.title')
      .orderBy('clicks', 'DESC')
      .getRawMany();

    return {
      items: result.map((r) => {
        const impressions = Number(r.impressions);
        const clicks = Number(r.clicks);
        return {
          bannerId: r.bannerId,
          title: r.title,
          impressions,
          clicks,
          ctr: impressions > 0 ? clicks / impressions : 0,
        };
      }),
    };
  }
}
