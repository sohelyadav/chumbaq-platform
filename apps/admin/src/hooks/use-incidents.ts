import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CertInIncidentType,
  IncidentDetail,
  IncidentReportMethod,
  IncidentSummary,
  SecurityAlertView,
  SecurityContact,
  TripwireView,
} from '@chumbaq/shared';
import { apiGet, apiPost, apiPut } from '@/lib/api';

export interface NewIncident {
  noticedAt?: string;
  howNoticed?: string;
  types: CertInIncidentType[];
  title: string;
  summary?: string;
  systems?: string;
  tenantIds?: string[];
  alertId?: string;
}

const INCIDENTS = ['admin', 'incidents'] as const;

export function useIncidents() {
  return useQuery<IncidentSummary[]>({
    queryKey: INCIDENTS,
    queryFn: () => apiGet<IncidentSummary[]>('/api/admin/incidents'),
    // The countdown is worked out in the browser; the list itself changes rarely.
    refetchInterval: 60_000,
  });
}

export function useIncident(id: string | undefined) {
  return useQuery<IncidentDetail>({
    queryKey: [...INCIDENTS, id],
    queryFn: () => apiGet<IncidentDetail>(`/api/admin/incidents/${id}`),
    enabled: Boolean(id),
  });
}

export function useReportDraft(id: string | undefined, enabled: boolean) {
  return useQuery<{ subject: string; body: string }>({
    queryKey: [...INCIDENTS, id, 'draft'],
    queryFn: () => apiGet<{ subject: string; body: string }>(`/api/admin/incidents/${id}/report-draft`),
    enabled: Boolean(id) && enabled,
    staleTime: 0,
  });
}

function useIncidentMutation<TInput>(run: (input: TInput) => Promise<IncidentDetail>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: (incident) => {
      queryClient.setQueryData([...INCIDENTS, incident.id], incident);
      void queryClient.invalidateQueries({ queryKey: INCIDENTS });
    },
  });
}

export function useRecordIncident() {
  return useIncidentMutation((input: NewIncident) => apiPost<IncidentDetail>('/api/admin/incidents', input));
}

export function useReportIncident(id: string) {
  return useIncidentMutation((input: { method: IncidentReportMethod; certinReference?: string; reportedAt?: string }) =>
    apiPost<IncidentDetail>(`/api/admin/incidents/${id}/report`, input),
  );
}

export function useAddIncidentNote(id: string) {
  return useIncidentMutation((note: string) => apiPost<IncidentDetail>(`/api/admin/incidents/${id}/notes`, { note }));
}

export function useCloseIncident(id: string) {
  return useIncidentMutation((note: string) => apiPost<IncidentDetail>(`/api/admin/incidents/${id}/close`, { note }));
}

export function useSecurityAlerts() {
  return useQuery<SecurityAlertView[]>({
    queryKey: ['admin', 'security-alerts'],
    queryFn: () => apiGet<SecurityAlertView[]>('/api/admin/security-alerts', { limit: 50 }),
    refetchInterval: 60_000,
  });
}

export function useSecurityContact() {
  return useQuery<SecurityContact>({
    queryKey: ['admin', 'security-contact'],
    queryFn: () => apiGet<SecurityContact>('/api/admin/security-contact'),
  });
}

export function useSaveSecurityContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contact: Omit<SecurityContact, 'updatedAt'>) =>
      apiPut<SecurityContact>('/api/admin/security-contact', contact),
    onSuccess: (saved) => queryClient.setQueryData(['admin', 'security-contact'], saved),
  });
}

const TRIPWIRES = ['admin', 'tripwires'] as const;

export function useTripwires() {
  return useQuery<TripwireView[]>({
    queryKey: TRIPWIRES,
    queryFn: () => apiGet<TripwireView[]>('/api/admin/tripwires'),
  });
}

export function useCreateTripwireKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (label: string) => apiPost<{ id: string; key: string }>('/api/admin/tripwires/api-key', { label }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TRIPWIRES }),
  });
}

export function useCreateTripwireAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; label: string }) =>
      apiPost<{ id: string }>('/api/admin/tripwires/account', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TRIPWIRES }),
  });
}

export function useRevokeTripwire() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiPost<{ revoked: true }>(`/api/admin/tripwires/${id}/revoke`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: TRIPWIRES }),
  });
}
