import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  AttributionResultEntity,
  AttributionModel,
  CreditSplit,
} from './entities/attribution-result.entity';
import { TouchpointsService } from '../touchpoints/touchpoints.service';
import { TouchpointEntity } from '../touchpoints/entities/touchpoint.entity';
import {
  lastTouch,
  firstTouch,
  linear,
  timeDecay,
} from './models/attribution-models';

const MODEL_FNS: Record<AttributionModel, (tps: TouchpointEntity[]) => CreditSplit[]> = {
  last_touch: lastTouch,
  first_touch: firstTouch,
  linear,
  time_decay: timeDecay,
};

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    @InjectRepository(AttributionResultEntity)
    private readonly resultRepository: Repository<AttributionResultEntity>,
    private readonly touchpointsService: TouchpointsService,
  ) {}

  async attributeConversion(params: {
    projectId: string;
    conversionId: string;
    distinctId: string;
    conversionTime: Date;
    model?: AttributionModel;
    lookbackDays?: number;
  }): Promise<AttributionResultEntity> {
    const model = params.model || 'linear';
    const lookbackDays = params.lookbackDays || 30;

    const touchpoints = await this.touchpointsService.getJourneyBeforeConversion(
      params.projectId,
      params.distinctId,
      params.conversionTime,
      lookbackDays,
    );

    const modelFn = MODEL_FNS[model];
    const creditSplits = modelFn(touchpoints);

    const result = this.resultRepository.create({
      projectId: params.projectId,
      conversionId: params.conversionId,
      distinctId: params.distinctId,
      model,
      creditSplits,
      touchpointCount: touchpoints.length,
      lookbackDays,
    });

    return this.resultRepository.save(result);
  }

  async attributeAllModels(params: {
    projectId: string;
    conversionId: string;
    distinctId: string;
    conversionTime: Date;
    lookbackDays?: number;
  }): Promise<AttributionResultEntity[]> {
    const lookbackDays = params.lookbackDays || 30;

    const touchpoints = await this.touchpointsService.getJourneyBeforeConversion(
      params.projectId,
      params.distinctId,
      params.conversionTime,
      lookbackDays,
    );

    const results: AttributionResultEntity[] = [];
    for (const [model, modelFn] of Object.entries(MODEL_FNS)) {
      const creditSplits = modelFn(touchpoints);
      const result = this.resultRepository.create({
        projectId: params.projectId,
        conversionId: params.conversionId,
        distinctId: params.distinctId,
        model: model as AttributionModel,
        creditSplits,
        touchpointCount: touchpoints.length,
        lookbackDays,
      });
      results.push(result);
    }

    return this.resultRepository.save(results);
  }

  async getChannelAttribution(
    projectId: string,
    model: AttributionModel = 'linear',
    start?: Date,
    end?: Date,
  ): Promise<{ channel: string; credit: number; conversions: number }[]> {
    const qb = this.resultRepository
      .createQueryBuilder('ar')
      .where('ar.project_id = :projectId', { projectId })
      .andWhere('ar.model = :model', { model });

    if (start) qb.andWhere('ar.created_at >= :start', { start });
    if (end) qb.andWhere('ar.created_at <= :end', { end });

    const results = await qb.getMany();

    // Aggregate credit by channel
    const channelCredits = new Map<string, { credit: number; conversions: Set<string> }>();

    for (const result of results) {
      for (const split of result.creditSplits) {
        const channel = split.channel || 'unknown';
        if (!channelCredits.has(channel)) {
          channelCredits.set(channel, { credit: 0, conversions: new Set() });
        }
        const entry = channelCredits.get(channel)!;
        entry.credit += split.credit;
        entry.conversions.add(result.conversionId);
      }
    }

    return Array.from(channelCredits.entries())
      .map(([channel, data]) => ({
        channel,
        credit: Math.round(data.credit * 100) / 100,
        conversions: data.conversions.size,
      }))
      .sort((a, b) => b.credit - a.credit);
  }

  async getCampaignAttribution(
    projectId: string,
    model: AttributionModel = 'linear',
    start?: Date,
    end?: Date,
  ): Promise<{ campaign: string; channel: string; credit: number; conversions: number }[]> {
    const qb = this.resultRepository
      .createQueryBuilder('ar')
      .where('ar.project_id = :projectId', { projectId })
      .andWhere('ar.model = :model', { model });

    if (start) qb.andWhere('ar.created_at >= :start', { start });
    if (end) qb.andWhere('ar.created_at <= :end', { end });

    const results = await qb.getMany();

    const campaignCredits = new Map<string, { credit: number; channel: string; conversions: Set<string> }>();

    for (const result of results) {
      for (const split of result.creditSplits) {
        const key = `${split.campaign || 'none'}::${split.channel || 'unknown'}`;
        if (!campaignCredits.has(key)) {
          campaignCredits.set(key, {
            credit: 0,
            channel: split.channel || 'unknown',
            conversions: new Set(),
          });
        }
        const entry = campaignCredits.get(key)!;
        entry.credit += split.credit;
        entry.conversions.add(result.conversionId);
      }
    }

    return Array.from(campaignCredits.entries())
      .map(([key, data]) => ({
        campaign: key.split('::')[0],
        channel: data.channel,
        credit: Math.round(data.credit * 100) / 100,
        conversions: data.conversions.size,
      }))
      .sort((a, b) => b.credit - a.credit);
  }

  async getConversionAttribution(
    projectId: string,
    conversionId: string,
  ): Promise<AttributionResultEntity[]> {
    return this.resultRepository.find({
      where: { conversionId, projectId },
      order: { model: 'ASC' },
    });
  }

  async getModelComparison(
    projectId: string,
    start?: Date,
    end?: Date,
  ): Promise<Record<string, { channel: string; credit: number }[]>> {
    const models: AttributionModel[] = ['last_touch', 'first_touch', 'linear', 'time_decay'];
    const comparison: Record<string, { channel: string; credit: number }[]> = {};

    for (const model of models) {
      const channelData = await this.getChannelAttribution(projectId, model, start, end);
      comparison[model] = channelData.map(({ channel, credit }) => ({ channel, credit }));
    }

    return comparison;
  }
}
