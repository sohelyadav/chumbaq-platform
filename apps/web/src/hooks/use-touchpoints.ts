import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface Touchpoint {
  id: string;
  touchpointType: string;
  channel: string;
  campaign: string;
  utmSource: string;
  utmMedium: string;
  utmCampaign: string;
  platform: string;
  touchedAt: string;
  linkId?: string;
  metadata?: Record<string, unknown>;
}

export interface ChannelSummaryEntry {
  channel: string;
  count: number;
  percentage: number;
}

export function useJourney(
  projectId: string | undefined,
  distinctId: string | undefined,
  lookbackDays?: number
) {
  const params: Record<string, unknown> = {};
  if (lookbackDays) params.lookbackDays = lookbackDays;

  return useQuery<Touchpoint[]>({
    queryKey: ['touchpoints', projectId, 'journey', distinctId, lookbackDays],
    queryFn: () =>
      apiGet<Touchpoint[]>(
        `/api/projects/${projectId}/touchpoints/journey/${distinctId}`,
        params
      ),
    enabled: !!projectId && !!distinctId,
  });
}

export function useChannelSummary(
  projectId: string | undefined,
  start?: string,
  end?: string
) {
  const params: Record<string, unknown> = {};
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<ChannelSummaryEntry[]>({
    queryKey: ['touchpoints', projectId, 'channels', start, end],
    queryFn: () =>
      apiGet<ChannelSummaryEntry[]>(
        `/api/projects/${projectId}/touchpoints/channels`,
        params
      ),
    enabled: !!projectId,
  });
}
