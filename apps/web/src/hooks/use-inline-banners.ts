import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export interface BannerCategory {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  layout: string;
  aspectRatio: string | null;
  autoRotate: boolean;
  rotationInterval: number;
  heading: string | null;
  backgroundColor: string;
  padding: number;
  config: Record<string, any> | null;
  status: 'draft' | 'active' | 'paused';
  bannerCount?: number;
  totalImpressions?: number;
  totalClicks?: number;
  banners?: InAppBanner[];
  createdAt: string;
  updatedAt: string;
}

export interface InAppBanner {
  id: string;
  categoryId: string;
  title: string;
  imageUrl: string;
  clickUrl: string;
  ctaText: string | null;
  sortOrder: number;
  isActive: boolean;
  startsAt: string | null;
  expiresAt: string | null;
  impressions: number;
  clicks: number;
  metadata: Record<string, any> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WidgetAnalyticsSummary {
  totalImpressions: number;
  totalClicks: number;
  ctr: number;
  uniqueVisitors: number;
}

export interface WidgetTimeseriesPoint {
  date: string;
  impressions: number;
  clicks: number;
}

export interface DeviceBreakdown {
  deviceTypes: { name: string; count: number }[];
  operatingSystems: { name: string; count: number }[];
  browsers: { name: string; count: number }[];
}

export interface GeoBreakdown {
  countries: { name: string; code: string; count: number }[];
  cities: { name: string; country: string; count: number }[];
}

export interface ItemStats {
  items: { bannerId: string; title: string; impressions: number; clicks: number; ctr: number }[];
}

// --- Banner Categories ---

export function useBannerCategories(projectId: string | undefined) {
  return useQuery<BannerCategory[]>({
    queryKey: ['banner-categories', projectId],
    queryFn: () => apiGet<BannerCategory[]>(`/api/projects/${projectId}/banner-categories`),
    enabled: !!projectId,
  });
}

export function useBannerCategoryDetail(categoryId: string | undefined) {
  return useQuery<BannerCategory>({
    queryKey: ['banner-category', categoryId],
    queryFn: () => apiGet<BannerCategory>(`/api/banner-categories/${categoryId}`),
    enabled: !!categoryId,
  });
}

export function useCreateBannerCategory(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BannerCategory>) =>
      apiPost<BannerCategory>(`/api/projects/${projectId}/banner-categories`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banner-categories', projectId] });
    },
  });
}

export function useUpdateBannerCategory(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<BannerCategory>) =>
      apiPatch<BannerCategory>(`/api/banner-categories/${categoryId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banner-categories'] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

export function useUpdateBannerCategoryStatus(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (status: string) =>
      apiPatch<BannerCategory>(`/api/banner-categories/${categoryId}/status`, { status }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banner-categories'] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

export function useDeleteBannerCategory(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/banner-categories/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['banner-categories', projectId] });
    },
  });
}

// --- In-App Banners ---

export function useInAppBanners(categoryId: string | undefined) {
  return useQuery<InAppBanner[]>({
    queryKey: ['in-app-banners', categoryId],
    queryFn: () => apiGet<InAppBanner[]>(`/api/banner-categories/${categoryId}/banners`),
    enabled: !!categoryId,
  });
}

export function useCreateInAppBanner(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<InAppBanner>) =>
      apiPost<InAppBanner>(`/api/banner-categories/${categoryId}/banners`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-banners', categoryId] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

export function useUpdateInAppBanner(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<InAppBanner>) =>
      apiPatch<InAppBanner>(`/api/in-app-banners/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-banners', categoryId] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

export function useDeleteInAppBanner(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/in-app-banners/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-banners', categoryId] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

export function useReorderBanners(categoryId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (items: { id: string; sortOrder: number }[]) =>
      apiPatch(`/api/banner-categories/${categoryId}/banners/reorder`, { items }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['in-app-banners', categoryId] });
      queryClient.invalidateQueries({ queryKey: ['banner-category', categoryId] });
    },
  });
}

// --- Widget Analytics ---

export function useWidgetAnalyticsSummary(categoryId: string | undefined) {
  return useQuery<WidgetAnalyticsSummary>({
    queryKey: ['widget-analytics-summary', categoryId],
    queryFn: () => apiGet<WidgetAnalyticsSummary>(`/api/banner-categories/${categoryId}/analytics`),
    enabled: !!categoryId,
  });
}

export function useWidgetAnalyticsTimeseries(
  categoryId: string | undefined,
  start?: string,
  end?: string,
  granularity?: string,
) {
  return useQuery<WidgetTimeseriesPoint[]>({
    queryKey: ['widget-analytics-timeseries', categoryId, start, end, granularity],
    queryFn: () => {
      const params: Record<string, unknown> = {};
      if (start) params.start = start;
      if (end) params.end = end;
      if (granularity) params.granularity = granularity;
      return apiGet<WidgetTimeseriesPoint[]>(
        `/api/banner-categories/${categoryId}/analytics/timeseries`,
        params,
      );
    },
    enabled: !!categoryId,
  });
}

export function useWidgetAnalyticsDevices(categoryId: string | undefined) {
  return useQuery<DeviceBreakdown>({
    queryKey: ['widget-analytics-devices', categoryId],
    queryFn: () => apiGet<DeviceBreakdown>(`/api/banner-categories/${categoryId}/analytics/devices`),
    enabled: !!categoryId,
  });
}

export function useWidgetAnalyticsGeo(categoryId: string | undefined) {
  return useQuery<GeoBreakdown>({
    queryKey: ['widget-analytics-geo', categoryId],
    queryFn: () => apiGet<GeoBreakdown>(`/api/banner-categories/${categoryId}/analytics/geo`),
    enabled: !!categoryId,
  });
}

export function useWidgetAnalyticsItems(categoryId: string | undefined) {
  return useQuery<ItemStats>({
    queryKey: ['widget-analytics-items', categoryId],
    queryFn: () => apiGet<ItemStats>(`/api/banner-categories/${categoryId}/analytics/items`),
    enabled: !!categoryId,
  });
}
