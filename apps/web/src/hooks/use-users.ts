import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiDelete, apiGet, apiPatch } from '@/lib/api';
import type { PersonErasureResult, PersonExport } from '@chumbaq/shared';

export interface UserMember {
  id: string;
  distinctId: string;
  externalUserId: string | null;
  displayName: string;
  email: string | null;
  phone: string | null;
  avatar: string | null;
  platform: string;
  os: string | null;
  browser: string | null;
  country: string | null;
  city: string | null;
  deviceCount: number;
  lastSeenAt: string;
  firstSeenAt: string;
  pushEnabled: boolean;
  totalEvents: number;
  totalSessions: number;
  totalRevenue: number;
  status: 'active' | 'inactive';
  initialUtmSource: string | null;
  initialUtmCampaign: string | null;
}

export interface UserStats {
  total: number;
  active30d: number;
  pushEnabled: number;
  newThisWeek: number;
  identified: number;
  withRevenue: number;
  totalRevenue: number;
  topCountries: { country: string; count: number }[];
  topPlatforms: { platform: string; count: number }[];
}

export interface UserMemberDetail extends UserMember {
  // Profile
  firstName: string | null;
  lastName: string | null;
  locale: string | null;
  language: string | null;
  // Device
  osVersion: string | null;
  browserVersion: string | null;
  appVersion: string | null;
  appBuild: string | null;
  manufacturer: string | null;
  brand: string | null;
  model: string | null;
  screenHeight: number | null;
  screenWidth: number | null;
  carrier: string | null;
  // Geo
  countryCode: string | null;
  region: string | null;
  timezone: string | null;
  latitude: number | null;
  longitude: number | null;
  // Attribution
  initialReferrer: string | null;
  initialReferringDomain: string | null;
  initialUtmMedium: string | null;
  initialUtmContent: string | null;
  initialUtmTerm: string | null;
  installSource: string | null;
  installCampaign: string | null;
  latestReferrer: string | null;
  latestUtmSource: string | null;
  latestUtmMedium: string | null;
  latestUtmCampaign: string | null;
  // Engagement
  currency: string | null;
  lastEventAt: string | null;
  daysSinceFirstSeen: number;
  daysSinceLastSeen: number;
  // Consent
  emailOptIn: boolean | null;
  smsOptIn: boolean | null;
  whatsappOptIn: boolean | null;
  pushOptIn: boolean | null;
  gdprConsent: boolean | null;
  doNotTrack: boolean;
  consentUpdatedAt: string | null;
  // Custom
  traits: Record<string, unknown>;
  // Related data
  pushTokens: any[];
  devices: {
    id: string;
    deviceFingerprint: string;
    platform: string;
    os: string | null;
    osVersion: string | null;
    browser: string | null;
    model: string | null;
    lastSeenAt: string;
  }[];
  recentEvents: any[];
  eventCounts: { eventName: string; count: number }[];
}

export function useUsers(
  projectId: string | undefined,
  opts: {
    search?: string;
    page?: number;
    limit?: number;
    status?: string;
    pushEnabled?: string;
    country?: string;
    platform?: string;
    hasRevenue?: string;
  },
) {
  const params: Record<string, unknown> = {};
  if (opts.search) params.search = opts.search;
  if (opts.page) params.page = opts.page;
  if (opts.limit) params.limit = opts.limit;
  if (opts.status) params.status = opts.status;
  if (opts.pushEnabled) params.pushEnabled = opts.pushEnabled;
  if (opts.country) params.country = opts.country;
  if (opts.platform) params.platform = opts.platform;
  if (opts.hasRevenue) params.hasRevenue = opts.hasRevenue;

  return useQuery<{ data: UserMember[]; meta: { page: number; limit: number; total: number; totalPages: number } }>({
    queryKey: ['users', projectId, opts],
    queryFn: () => apiGet(`/api/projects/${projectId}/users`, params),
    enabled: !!projectId,
  });
}

export function useUserStats(projectId: string | undefined) {
  return useQuery<UserStats>({
    queryKey: ['user-stats', projectId],
    queryFn: () => apiGet<UserStats>(`/api/projects/${projectId}/users/stats`),
    enabled: !!projectId,
  });
}

export function useUserMemberDetail(projectId: string | undefined, memberId: string | undefined) {
  return useQuery<UserMemberDetail>({
    queryKey: ['user-member-detail', projectId, memberId],
    queryFn: () => apiGet<UserMemberDetail>(`/api/projects/${projectId}/users/${memberId}`),
    enabled: !!projectId && !!memberId,
  });
}

export function useUserMemberEvents(
  projectId: string | undefined,
  memberId: string | undefined,
  opts: { page?: number; limit?: number; eventName?: string },
) {
  const params: Record<string, unknown> = {};
  if (opts.page) params.page = opts.page;
  if (opts.limit) params.limit = opts.limit;
  if (opts.eventName) params.eventName = opts.eventName;

  return useQuery<{ data: any[]; total: number }>({
    queryKey: ['user-member-events', projectId, memberId, opts],
    queryFn: () => apiGet(`/api/projects/${projectId}/users/${memberId}/events`, params),
    enabled: !!projectId && !!memberId,
  });
}

export function useUpdateUserMemberTraits(projectId: string, memberId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (traits: Record<string, unknown>) =>
      apiPatch(`/api/projects/${projectId}/users/${memberId}/traits`, traits),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['user-member-detail', projectId, memberId] });
    },
  });
}

// ─── Privacy: erase and export one person (DPDP) ───

/** Deletes everything held about the person. Needs a recent sign-in; the API client prompts for it. */
export function useErasePerson(projectId: string, personId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      apiDelete<PersonErasureResult>(`/api/projects/${projectId}/users/${personId}`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['user-member-detail', projectId, personId] });
      queryClient.invalidateQueries({ queryKey: ['users', projectId] });
      queryClient.invalidateQueries({ queryKey: ['user-stats', projectId] });
    },
  });
}

/** Fetches the person's data and saves it as a JSON file. */
export async function downloadPersonExport(projectId: string, personId: string): Promise<PersonExport> {
  const data = await apiGet<PersonExport>(`/api/projects/${projectId}/users/${personId}/export`);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `person-${personId}-export.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers start the download after click() returns; revoking at once can cancel it.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  return data;
}
