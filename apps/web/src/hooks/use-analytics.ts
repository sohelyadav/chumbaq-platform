import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface AnalyticsSummary {
  totalClicks: number;
  uniqueVisitors: number;
  appOpens: number;
  storeRedirects: number;
  matchedInstalls: number;
  conversionsByType: { eventType: string; count: number }[];
  conversionRate: number;
}

export interface TimeseriesPoint {
  date: string;
  clicks: number;
}

export interface DeviceBreakdown {
  deviceTypes: Array<{ name: string; count: number }>;
  operatingSystems: Array<{ name: string; count: number }>;
  browsers: Array<{ name: string; count: number }>;
}

export interface GeoPoint {
  lat: number;
  lng: number;
  city: string;
  country: string;
  count: number;
}

export interface GeoBreakdown {
  countries: Array<{ name: string; code: string; count: number }>;
  cities: Array<{ name: string; region: string; country: string; count: number }>;
  points: GeoPoint[];
}

export interface ReferrerEntry {
  referrer: string;
  count: number;
}

export interface DashboardStats {
  totalLinks: number;
  clicks24h: number;
  clicks7d: number;
  clicks30d: number;
  totalConversions: number;
  topLinks: Array<{
    id: string;
    shortCode: string;
    title: string;
    clicks: number;
  }>;
}

export function useLinkAnalytics(linkId: string | undefined) {
  return useQuery<AnalyticsSummary>({
    queryKey: ['analytics', linkId],
    queryFn: () => apiGet<AnalyticsSummary>(`/api/links/${linkId}/analytics`),
    enabled: !!linkId,
  });
}

export function useLinkTimeseries(
  linkId: string | undefined,
  start?: string,
  end?: string,
  granularity = 'day'
) {
  const params: Record<string, unknown> = { granularity };
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<TimeseriesPoint[]>({
    queryKey: ['analytics', linkId, 'timeseries', start, end, granularity],
    queryFn: () =>
      apiGet<TimeseriesPoint[]>(`/api/links/${linkId}/analytics/timeseries`, params),
    enabled: !!linkId,
  });
}

export function useLinkDevices(linkId: string | undefined) {
  return useQuery<DeviceBreakdown>({
    queryKey: ['analytics', linkId, 'devices'],
    queryFn: () => apiGet<DeviceBreakdown>(`/api/links/${linkId}/analytics/devices`),
    enabled: !!linkId,
  });
}

export function useLinkGeo(linkId: string | undefined) {
  return useQuery<GeoBreakdown>({
    queryKey: ['analytics', linkId, 'geo'],
    queryFn: () => apiGet<GeoBreakdown>(`/api/links/${linkId}/analytics/geo`),
    enabled: !!linkId,
  });
}

export function useLinkReferrers(linkId: string | undefined) {
  return useQuery<ReferrerEntry[]>({
    queryKey: ['analytics', linkId, 'referrers'],
    queryFn: () => apiGet<ReferrerEntry[]>(`/api/links/${linkId}/analytics/referrers`),
    enabled: !!linkId,
  });
}

export function useProjectAnalyticsSummary(projectId: string | undefined) {
  return useQuery<AnalyticsSummary>({
    queryKey: ['project-analytics', projectId, 'summary'],
    queryFn: () => apiGet<AnalyticsSummary>(`/api/projects/${projectId}/analytics/summary`),
    enabled: !!projectId,
  });
}

export function useProjectTimeseries(
  projectId: string | undefined,
  start?: string,
  end?: string,
  granularity = 'day'
) {
  const params: Record<string, unknown> = { granularity };
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<TimeseriesPoint[]>({
    queryKey: ['project-analytics', projectId, 'timeseries', start, end, granularity],
    queryFn: () =>
      apiGet<TimeseriesPoint[]>(`/api/projects/${projectId}/analytics/timeseries`, params),
    enabled: !!projectId,
  });
}

export function useProjectDevices(projectId: string | undefined) {
  return useQuery<DeviceBreakdown>({
    queryKey: ['project-analytics', projectId, 'devices'],
    queryFn: () => apiGet<DeviceBreakdown>(`/api/projects/${projectId}/analytics/devices`),
    enabled: !!projectId,
  });
}

export function useProjectGeo(projectId: string | undefined) {
  return useQuery<GeoBreakdown>({
    queryKey: ['project-analytics', projectId, 'geo'],
    queryFn: () => apiGet<GeoBreakdown>(`/api/projects/${projectId}/analytics/geo`),
    enabled: !!projectId,
  });
}

export function useProjectReferrers(projectId: string | undefined) {
  return useQuery<ReferrerEntry[]>({
    queryKey: ['project-analytics', projectId, 'referrers'],
    queryFn: () => apiGet<ReferrerEntry[]>(`/api/projects/${projectId}/analytics/referrers`),
    enabled: !!projectId,
  });
}

export function useDashboardStats() {
  return useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: () => apiGet<DashboardStats>('/api/dashboard/stats'),
  });
}

export function useProjectDashboardStats(projectId: string) {
  return useQuery<DashboardStats>({
    queryKey: ['project-dashboard-stats', projectId],
    queryFn: () => apiGet<DashboardStats>(`/api/projects/${projectId}/stats`),
    enabled: !!projectId,
  });
}

export function useExportClicksCsv(linkId: string | undefined, start?: string, end?: string) {
  const params: Record<string, unknown> = {};
  if (start) params.start = start;
  if (end) params.end = end;

  return useQuery<string>({
    queryKey: ['analytics-export', linkId, start, end],
    queryFn: () => apiGet<string>(`/api/links/${linkId}/analytics/export`, params),
    enabled: false, // manual trigger only
  });
}
