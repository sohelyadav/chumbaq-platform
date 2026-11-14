import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { dateTruncUnit } from '../../common/date-trunc-unit';
import { UserEventEntity } from './entities/user-event.entity';
import { IdentityService } from '../identity/identity.service';
import { TrackEventDto } from './dto/track-event.dto';
import { TrackingConsentService } from '../consent/tracking-consent.service';

@Injectable()
export class EventsService {
  private readonly logger = new Logger(EventsService.name);

  constructor(
    @InjectRepository(UserEventEntity)
    private readonly eventRepository: Repository<UserEventEntity>,
    private readonly identityService: IdentityService,
    private readonly trackingConsent: TrackingConsentService,
  ) {}

  /**
   * Stores an event from an SDK, or returns null without storing it when the
   * person it is about is do-not-track. The controller still answers 2xx:
   * the SDK queues treat a 4xx as terminal and a 5xx as retry, and an event
   * refused on consent should be neither an error nor tried again.
   */
  async track(dto: TrackEventDto): Promise<UserEventEntity | null> {
    if (
      await this.trackingConsent.isDoNotTrack({
        projectId: dto.projectId,
        deviceFingerprint: dto.deviceFingerprint ?? null,
        distinctId: dto.distinctId ?? null,
      })
    ) {
      this.trackingConsent.recordDrop('event');
      return null;
    }


    let deviceIdentityId: string | null = null;
    let distinctId = dto.distinctId || null;

    // Resolve device identity if fingerprint provided
    if (dto.deviceFingerprint) {
      const identity = await this.identityService.findByFingerprintAndProject(
        dto.deviceFingerprint,
        dto.projectId,
      );
      if (identity) {
        deviceIdentityId = identity.id;
        if (!distinctId) {
          distinctId = identity.distinctId || identity.deviceFingerprint;
        }
        // Update lastSeenAt and lastEventAt
        this.identityService.updateLastSeen(identity.id).catch(() => {});
        this.identityService.updateLastEventAt(dto.projectId, identity.id).catch(() => {});
      }
    }

    const event = this.eventRepository.create({
      projectId: dto.projectId,
      deviceIdentityId,
      distinctId,
      eventName: dto.eventName,
      properties: dto.properties || null,
      sourceType: 'sdk',
      timestamp: dto.timestamp ? new Date(dto.timestamp) : new Date(),
    } as Partial<UserEventEntity>);

    return this.eventRepository.save(event as UserEventEntity);
  }

  async trackServerEvent(params: {
    projectId: string;
    distinctId?: string;
    deviceIdentityId?: string;
    eventName: string;
    properties?: Record<string, unknown>;
    sourceType: string;
    sourceId?: string;
    ipAddress?: string;
    userAgent?: string;
    platform?: string;
    country?: string;
    city?: string;
  }): Promise<UserEventEntity> {
    const event = this.eventRepository.create({
      projectId: params.projectId,
      distinctId: params.distinctId || null,
      deviceIdentityId: params.deviceIdentityId || null,
      eventName: params.eventName,
      properties: params.properties || null,
      sourceType: params.sourceType,
      sourceId: params.sourceId || null,
      ipAddress: params.ipAddress || null,
      userAgent: params.userAgent || null,
      platform: params.platform || null,
      country: params.country || null,
      city: params.city || null,
    } as Partial<UserEventEntity>);

    return this.eventRepository.save(event as UserEventEntity);
  }

  async queryByUser(
    projectId: string,
    distinctId: string,
    opts: { limit?: number; offset?: number; eventName?: string },
  ): Promise<{ data: UserEventEntity[]; total: number }> {
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.distinct_id = :distinctId', { distinctId });

    if (opts.eventName) {
      qb.andWhere('event.event_name = :eventName', { eventName: opts.eventName });
    }

    qb.orderBy('event.timestamp', 'DESC')
      .take(opts.limit || 50)
      .skip(opts.offset || 0);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async queryByProject(
    projectId: string,
    opts: {
      limit?: number;
      offset?: number;
      eventName?: string;
      start?: string;
      end?: string;
    },
  ): Promise<{ data: UserEventEntity[]; total: number }> {
    const qb = this.eventRepository
      .createQueryBuilder('event')
      .where('event.project_id = :projectId', { projectId });

    if (opts.eventName) {
      qb.andWhere('event.event_name = :eventName', { eventName: opts.eventName });
    }
    if (opts.start) {
      qb.andWhere('event.timestamp >= :start', { start: new Date(opts.start) });
    }
    if (opts.end) {
      qb.andWhere('event.timestamp <= :end', { end: new Date(opts.end) });
    }

    qb.orderBy('event.timestamp', 'DESC')
      .take(opts.limit || 50)
      .skip(opts.offset || 0);

    const [data, total] = await qb.getManyAndCount();
    return { data, total };
  }

  async getEventNames(projectId: string): Promise<{ eventName: string; count: number }[]> {
    return this.eventRepository
      .createQueryBuilder('event')
      .select('event.event_name', 'eventName')
      .addSelect('COUNT(*)::int', 'count')
      .where('event.project_id = :projectId', { projectId })
      .groupBy('event.event_name')
      .orderBy('count', 'DESC')
      .getRawMany();
  }

  async getEventVolume(
    projectId: string,
    opts: {
      start?: string;
      end?: string;
      granularity?: 'hour' | 'day' | 'week';
      eventName?: string;
    },
  ): Promise<{ date: string; count: number }[]> {
    const gran = dateTruncUnit(opts.granularity);
    const now = new Date();
    const start = opts.start ? new Date(opts.start) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const end = opts.end ? new Date(opts.end) : now;

    const qb = this.eventRepository
      .createQueryBuilder('event')
      .select(`DATE_TRUNC('${gran}', event.timestamp)`, 'date')
      .addSelect('COUNT(*)::int', 'count')
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.timestamp >= :start', { start })
      .andWhere('event.timestamp <= :end', { end });

    if (opts.eventName) {
      qb.andWhere('event.event_name = :eventName', { eventName: opts.eventName });
    }

    const result = await qb
      .groupBy(`DATE_TRUNC('${gran}', event.timestamp)`)
      .orderBy('date', 'ASC')
      .getRawMany();

    return result.map((r) => ({ date: r.date, count: Number(r.count) }));
  }

  async getEventBreakdown(
    projectId: string,
    opts: { start?: string; end?: string },
  ): Promise<{ eventName: string; count: number }[]> {
    const now = new Date();
    const start = opts.start ? new Date(opts.start) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const end = opts.end ? new Date(opts.end) : now;

    return this.eventRepository
      .createQueryBuilder('event')
      .select('event.event_name', 'eventName')
      .addSelect('COUNT(*)::int', 'count')
      .where('event.project_id = :projectId', { projectId })
      .andWhere('event.timestamp >= :start', { start })
      .andWhere('event.timestamp <= :end', { end })
      .groupBy('event.event_name')
      .orderBy('count', 'DESC')
      .limit(20)
      .getRawMany();
  }

  async updateDistinctId(
    projectId: string,
    oldDistinctId: string,
    newDistinctId: string,
  ): Promise<void> {
    await this.eventRepository
      .createQueryBuilder()
      .update(UserEventEntity)
      .set({ distinctId: newDistinctId })
      .where('project_id = :projectId', { projectId })
      .andWhere('distinct_id = :oldDistinctId', { oldDistinctId })
      .execute();
  }
}
