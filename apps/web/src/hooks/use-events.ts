import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface UserEvent {
  id: string;
  projectId: string;
  distinctId: string;
  eventName: string;
  properties: Record<string, unknown> | null;
  sourceType: string;
  platform: string;
  country: string;
  city: string;
  timestamp: string;
}

export function useProjectEvents(
  projectId: string | undefined,
  opts: { page?: number; limit?: number; eventName?: string; start?: string; end?: string },
) {
  const params: Record<string, unknown> = {};
  if (opts.page) params.offset = ((opts.page - 1) * (opts.limit || 50));
  if (opts.limit) params.limit = opts.limit;
  if (opts.eventName) params.eventName = opts.eventName;
  if (opts.start) params.start = opts.start;
  if (opts.end) params.end = opts.end;

  return useQuery<{ data: UserEvent[]; total: number }>({
    queryKey: ['project-events', projectId, opts],
    queryFn: () => apiGet(`/api/projects/${projectId}/events`, params),
    enabled: !!projectId,
  });
}

export function useEventNames(projectId: string | undefined) {
  return useQuery<{ eventName: string; count: number }[]>({
    queryKey: ['event-names', projectId],
    queryFn: () => apiGet(`/api/projects/${projectId}/events/names`),
    enabled: !!projectId,
  });
}

export function useEventVolume(
  projectId: string | undefined,
  opts: { start?: string; end?: string; granularity?: string; eventName?: string },
) {
  return useQuery<{ date: string; count: number }[]>({
    queryKey: ['event-volume', projectId, opts],
    queryFn: () => apiGet(`/api/projects/${projectId}/events/volume`, opts as Record<string, unknown>),
    enabled: !!projectId,
  });
}

export function useEventBreakdown(
  projectId: string | undefined,
  opts: { start?: string; end?: string },
) {
  return useQuery<{ eventName: string; count: number }[]>({
    queryKey: ['event-breakdown', projectId, opts],
    queryFn: () => apiGet(`/api/projects/${projectId}/events/breakdown`, opts as Record<string, unknown>),
    enabled: !!projectId,
  });
}
