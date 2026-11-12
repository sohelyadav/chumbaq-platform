import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { WhatsAppContent } from '@/hooks/use-whatsapp';

/** What puts someone into a journey. Mirrors `JourneyTrigger` on the API. */
export type JourneyTrigger =
  | { type: 'event'; eventName: string }
  | { type: 'segment_entry'; segmentId: string };

export interface WaitStep {
  type: 'wait';
  durationSeconds: number;
}

export interface SendPushStep {
  type: 'send_push';
  title: string;
  body?: string;
  imageUrl?: string;
  deepLinkUrl?: string;
}

/** Emails the person through the project's email provider. */
export interface SendEmailStep {
  type: 'send_email';
  subject: string;
  html: string;
  text?: string;
  preheader?: string;
}

/** Texts the person through the project's SMS provider. */
export interface SendSmsStep {
  type: 'send_sms';
  body: string;
}

/** Sends one approved WhatsApp template through the project's provider. */
export interface SendWhatsAppStep {
  type: 'send_whatsapp';
  content: WhatsAppContent;
}

/**
 * A fork in the journey. `ifMember` and `ifNot` are indexes into the same step
 * list, which is why reordering steps is a destructive edit rather than a
 * cosmetic one.
 */
export interface BranchStep {
  type: 'branch';
  segmentId: string;
  ifMember: number;
  ifNot: number;
}

export interface ExitStep {
  type: 'exit';
}

export type JourneyStep =
  | WaitStep
  | SendPushStep
  | SendEmailStep
  | SendSmsStep
  | SendWhatsAppStep
  | BranchStep
  | ExitStep;

/**
 * `active` is the only status that enrols. `paused` stops enrolment but lets
 * people already inside finish, because stopping someone between a message and
 * its follow-up is worse than letting the journey drain.
 */
export type JourneyStatus = 'draft' | 'active' | 'paused' | 'archived';

export interface Journey {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  status: JourneyStatus;
  trigger: JourneyTrigger;
  steps: JourneyStep[];
  /** Enrolment only looks forward from here — set when the journey is activated. */
  enrolledThrough: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface JourneyStats {
  active: number;
  completed: number;
  exited: number;
  failed: number;
}

export interface JourneyInput {
  name: string;
  description?: string | null;
  trigger: JourneyTrigger;
  steps: JourneyStep[];
}

/** Below this a wait is indistinguishable from no wait. Matches the API. */
export const MIN_WAIT_SECONDS = 60;

export function useJourneys(projectId: string | undefined) {
  return useQuery<Journey[]>({
    queryKey: ['journeys', projectId],
    queryFn: () => apiGet<Journey[]>(`/api/projects/${projectId}/journeys`),
    enabled: !!projectId,
  });
}

export function useJourney(
  projectId: string | undefined,
  journeyId: string | undefined,
) {
  return useQuery<Journey>({
    queryKey: ['journey', projectId, journeyId],
    queryFn: () =>
      apiGet<Journey>(`/api/projects/${projectId}/journeys/${journeyId}`),
    enabled: !!projectId && !!journeyId,
    retry: false,
  });
}

/** How many people are in the journey, and how they left it. */
export function useJourneyStats(
  projectId: string | undefined,
  journeyId: string | undefined,
) {
  return useQuery<JourneyStats>({
    queryKey: ['journey-stats', projectId, journeyId],
    queryFn: () =>
      apiGet<JourneyStats>(
        `/api/projects/${projectId}/journeys/${journeyId}/stats`,
      ),
    enabled: !!projectId && !!journeyId,
    // People move through a journey over hours; a live-ticking count would be
    // noise, but a stale one on an open page reads as a broken journey.
    refetchInterval: 30_000,
  });
}

export function useCreateJourney(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: JourneyInput) =>
      apiPost<Journey>(`/api/projects/${projectId}/journeys`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['journeys', projectId] });
    },
  });
}

/**
 * Edits a journey.
 *
 * The API refuses this while the journey is active: people are partway through
 * the steps as they stand, and renumbering underneath them moves someone to a
 * step that means something else. Pause first.
 */
export function useUpdateJourney(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<JourneyInput> & { id: string }) =>
      apiPatch<Journey>(`/api/projects/${projectId}/journeys/${id}`, input),
    onSuccess: (journey) => {
      queryClient.invalidateQueries({ queryKey: ['journeys', projectId] });
      queryClient.invalidateQueries({
        queryKey: ['journey', projectId, journey.id],
      });
    },
  });
}

/**
 * Moves a journey between states.
 *
 * Its own call rather than a field on the edit, because activating is not a
 * field change: it sets the enrolment watermark and starts sending real
 * messages to real people.
 */
export function useSetJourneyStatus(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: JourneyStatus }) =>
      apiPost<Journey>(`/api/projects/${projectId}/journeys/${id}/status`, {
        status,
      }),
    onSuccess: (journey) => {
      queryClient.invalidateQueries({ queryKey: ['journeys', projectId] });
      queryClient.invalidateQueries({
        queryKey: ['journey', projectId, journey.id],
      });
    },
  });
}

export function useDeleteJourney(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ deleted: true }>(`/api/projects/${projectId}/journeys/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['journeys', projectId] });
    },
  });
}
