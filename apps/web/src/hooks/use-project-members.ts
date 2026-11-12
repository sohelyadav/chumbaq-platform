import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  CreatedInvitation,
  InvitationPreview,
  ProjectInvitation,
  ProjectMembersResponse,
  ProjectRole,
} from '@chumbaq/shared';
import { apiDelete, apiGet, apiPatch, apiPost } from '@/lib/api';

/**
 * A project's members, pending invitations and billing offer
 * (`modules/project-access`). Writes that need a recent sign-in are answered by
 * `ReauthDialog` through the API client, so nothing here asks for it.
 */

const membersKey = (projectId: string | undefined) => ['project-members', projectId];
const invitationsKey = (projectId: string | undefined) => ['project-invitations', projectId];

export function useProjectMembers(projectId: string | undefined) {
  return useQuery<ProjectMembersResponse>({
    queryKey: membersKey(projectId),
    queryFn: () => apiGet<ProjectMembersResponse>(`/api/projects/${projectId}/members`),
    enabled: !!projectId,
  });
}

/** Needs `members.manage`; pass `enabled: false` for anyone without it. */
export function useProjectInvitations(projectId: string | undefined, enabled: boolean) {
  return useQuery<ProjectInvitation[]>({
    queryKey: invitationsKey(projectId),
    queryFn: () => apiGet<ProjectInvitation[]>(`/api/projects/${projectId}/invitations`),
    enabled: !!projectId && enabled,
  });
}

/** The member and billing writes answer with the new list, so it is set rather than refetched. */
function useMembersWrite<TVars>(projectId: string, request: (vars: TVars) => Promise<ProjectMembersResponse>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: (response) => {
      queryClient.setQueryData(membersKey(projectId), response);
      // Removing or demoting someone can revoke invites they sent, and frees seats.
      queryClient.invalidateQueries({ queryKey: invitationsKey(projectId) });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', projectId] });
    },
  });
}

export function useChangeMemberRole(projectId: string) {
  return useMembersWrite(projectId, ({ userId, role }: { userId: string; role: ProjectRole }) =>
    apiPatch<ProjectMembersResponse>(`/api/projects/${projectId}/members/${userId}`, { role }),
  );
}

export function useRemoveMember(projectId: string) {
  return useMembersWrite(projectId, (userId: string) =>
    apiDelete<ProjectMembersResponse>(`/api/projects/${projectId}/members/${userId}`),
  );
}

export function useOfferBilling(projectId: string) {
  return useMembersWrite(projectId, (toUserId: string) =>
    apiPost<ProjectMembersResponse>(`/api/projects/${projectId}/billing-transfer`, { toUserId }),
  );
}

export function useCancelBillingOffer(projectId: string) {
  return useMembersWrite<void>(projectId, () =>
    apiDelete<ProjectMembersResponse>(`/api/projects/${projectId}/billing-transfer`),
  );
}

export function useAcceptBilling(projectId: string) {
  return useMembersWrite<void>(projectId, () =>
    apiPost<ProjectMembersResponse>(`/api/projects/${projectId}/billing-transfer/accept`),
  );
}

export function useDeclineBilling(projectId: string) {
  return useMembersWrite<void>(projectId, () =>
    apiPost<ProjectMembersResponse>(`/api/projects/${projectId}/billing-transfer/decline`),
  );
}

export function useLeaveProject(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiPost<{ left: true }>(`/api/projects/${projectId}/leave`),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: ['project', projectId] });
      queryClient.removeQueries({ queryKey: membersKey(projectId) });
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

function useInvitationWrite<TVars, TResult>(projectId: string, request: (vars: TVars) => Promise<TResult>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: request,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: invitationsKey(projectId) });
      // Pending invites hold seats.
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** The answer carries the invite link, the only copy there will be. Never cache or log it. */
export function useCreateInvitation(projectId: string) {
  return useInvitationWrite(projectId, (body: { email: string; role: ProjectRole }) =>
    apiPost<CreatedInvitation>(`/api/projects/${projectId}/invitations`, body),
  );
}

/** A new link and 7 more days; the old link stops working. */
export function useResendInvitation(projectId: string) {
  return useInvitationWrite(projectId, (invitationId: string) =>
    apiPost<CreatedInvitation>(`/api/projects/${projectId}/invitations/${invitationId}/resend`),
  );
}

export function useRevokeInvitation(projectId: string) {
  return useInvitationWrite(projectId, (invitationId: string) =>
    apiDelete<ProjectInvitation[]>(`/api/projects/${projectId}/invitations/${invitationId}`),
  );
}

/** A read over POST so the token stays out of URLs. Not cached: it is per token. */
export function usePreviewInvitation() {
  return useMutation({
    mutationFn: (token: string) => apiPost<InvitationPreview>('/api/invitations/preview', { token }),
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (token: string) =>
      apiPost<{ projectId: string; role: ProjectRole }>('/api/invitations/accept', { token }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** The API's own words for a refusal, which say what happened and what to do. */
export function serverMessage(err: unknown): string | null {
  const message = (err as { response?: { data?: { message?: unknown } } } | null)?.response?.data?.message;
  return typeof message === 'string' && message ? message : null;
}

/**
 * `RecentAuthGuard`'s refusal is what is left when the person cancels `ReauthDialog`.
 * They know why nothing happened, so it needs no second message.
 */
export function reauthCancelled(err: unknown): boolean {
  return serverMessage(err) === 'Confirm it is you to continue.';
}
