import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface ChannelAttribution {
  channel: string;
  credit: number;
  conversions: number;
}

export interface CampaignAttribution {
  campaign: string;
  channel: string;
  credit: number;
  conversions: number;
}

export interface ModelComparisonEntry {
  channel: string;
  last_touch: number;
  first_touch: number;
  linear: number;
  time_decay: number;
}

export type AttributionModel = 'last_touch' | 'first_touch' | 'linear' | 'time_decay';

type ModelComparisonByModel = Partial<Record<AttributionModel, { channel: string; credit: number }[]>>;

function normalizeModelComparison(
  response: ModelComparisonEntry[] | ModelComparisonByModel
): ModelComparisonEntry[] {
  if (Array.isArray(response)) {
    return response;
  }

  if (!response || typeof response !== 'object') {
    return [];
  }

  const byChannel = new Map<string, ModelComparisonEntry>();
  const models: AttributionModel[] = ['last_touch', 'first_touch', 'linear', 'time_decay'];

  for (const model of models) {
    const rows = response[model];
    if (!Array.isArray(rows)) {
      continue;
    }

    for (const row of rows) {
      if (!row?.channel) {
        continue;
      }

      if (!byChannel.has(row.channel)) {
        byChannel.set(row.channel, {
          channel: row.channel,
          last_touch: 0,
          first_touch: 0,
          linear: 0,
          time_decay: 0,
        });
      }

      const entry = byChannel.get(row.channel)!;
      entry[model] = Number(row.credit) || 0;
    }
  }

  return Array.from(byChannel.values());
}

export function useChannelAttribution(
  projectId: string | undefined,
  model?: AttributionModel,
  start?: string,
  end?: string
) {
  const params: Record<string, unknown> = {};
  if (model) params.model = model;
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<ChannelAttribution[]>({
    queryKey: ['attribution', projectId, 'channels', model, start, end],
    queryFn: () =>
      apiGet<ChannelAttribution[]>(
        `/api/projects/${projectId}/attribution/channels`,
        params
      ),
    enabled: !!projectId,
  });
}

export function useCampaignAttribution(
  projectId: string | undefined,
  model?: AttributionModel,
  start?: string,
  end?: string
) {
  const params: Record<string, unknown> = {};
  if (model) params.model = model;
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<CampaignAttribution[]>({
    queryKey: ['attribution', projectId, 'campaigns', model, start, end],
    queryFn: () =>
      apiGet<CampaignAttribution[]>(
        `/api/projects/${projectId}/attribution/campaigns`,
        params
      ),
    enabled: !!projectId,
  });
}

export function useModelComparison(
  projectId: string | undefined,
  start?: string,
  end?: string
) {
  const params: Record<string, unknown> = {};
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<ModelComparisonEntry[]>({
    queryKey: ['attribution', projectId, 'compare', start, end],
    queryFn: async () => {
      const response = await apiGet<ModelComparisonEntry[] | ModelComparisonByModel>(
        `/api/projects/${projectId}/attribution/compare`,
        params
      );
      return normalizeModelComparison(response);
    },
    enabled: !!projectId,
  });
}
