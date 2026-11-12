import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type {
  SegmentAstNode,
  SegmentAttributeOp,
  SegmentEvaluationMode,
  SegmentOccurrence,
  SegmentStatus,
} from '@chumbaq/shared';

export type {
  SegmentAstNode,
  SegmentAttributeOp,
  SegmentEvaluationMode,
  SegmentOccurrence,
  SegmentStatus,
};

/**
 * A segment as the list and detail endpoints return it.
 *
 * Narrower than `@chumbaq/shared`'s `Segment`: timestamps arrive as ISO
 * strings over the wire rather than as `Date`, and the optional fields are
 * explicitly nullable because the API sends `null`, not `undefined`.
 */
export interface Segment {
  id: string;
  projectId: string;
  name: string;
  description: string | null;
  definition: SegmentAstNode;
  evaluationMode: SegmentEvaluationMode;
  refreshIntervalMinutes: number;
  status: SegmentStatus;
  errorMessage: string | null;
  lastMemberCount: number | null;
  lastMaterializedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SegmentInput {
  name: string;
  description?: string;
  definition: SegmentAstNode;
  evaluationMode?: SegmentEvaluationMode;
  refreshIntervalMinutes?: number;
  status?: 'draft' | 'active';
}

/** Lower is faster to refresh; the API enforces this range. */
export const MIN_REFRESH_MINUTES = 5;
export const MAX_REFRESH_MINUTES = 1440;

/** Mirrors the API's own guardrails, so the UI refuses before the server does. */
export const MAX_WITHIN_DAYS = 365;
export const MAX_RULES = 50;

export function useSegments(projectId: string | undefined) {
  // The list endpoint returns a bare array; TransformInterceptor supplies the
  // `data` envelope and apiGet strips it. Unlike the paginated endpoints there
  // is no `{ data, total }` inside.
  return useQuery<Segment[]>({
    queryKey: ['segments', projectId],
    queryFn: () => apiGet<Segment[]>(`/api/projects/${projectId}/segments`),
    enabled: !!projectId,
  });
}

export function useSegment(projectId: string | undefined, id: string | undefined) {
  return useQuery<Segment>({
    queryKey: ['segment', projectId, id],
    queryFn: () => apiGet<Segment>(`/api/projects/${projectId}/segments/${id}`),
    enabled: !!projectId && !!id,
  });
}

export function useCreateSegment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: SegmentInput) =>
      apiPost<Segment>(`/api/projects/${projectId}/segments`, input),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['segments', projectId] });
    },
  });
}

export function useUpdateSegment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: Partial<SegmentInput> & { id: string }) =>
      apiPatch<Segment>(`/api/projects/${projectId}/segments/${id}`, input),
    onSuccess: (segment) => {
      queryClient.invalidateQueries({ queryKey: ['segments', projectId] });
      queryClient.invalidateQueries({ queryKey: ['segment', projectId, segment.id] });
    },
  });
}

export function useDeleteSegment(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete<{ deleted: true }>(`/api/projects/${projectId}/segments/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['segments', projectId] });
    },
  });
}

/**
 * Counts an unsaved definition.
 *
 * A mutation rather than a query on purpose: it is a POST with a body, and
 * keying a cache on a whole AST would mean serialising the tree into a query
 * key on every keystroke. The editor debounces and calls this itself, so the
 * count belongs to the edit in flight rather than to a cache entry.
 */
export function usePreviewSegment(projectId: string) {
  return useMutation({
    mutationFn: (definition: SegmentAstNode) =>
      apiPost<{ count: number }>(`/api/projects/${projectId}/segments/preview`, {
        definition,
      }),
  });
}

export interface SegmentMembersPage {
  personKeys: string[];
  nextCursor: string | null;
}

export function useSegmentMembers(
  projectId: string | undefined,
  id: string | undefined,
  limit = 25,
) {
  return useQuery<SegmentMembersPage>({
    queryKey: ['segment-members', projectId, id, limit],
    queryFn: () =>
      apiGet<SegmentMembersPage>(
        `/api/projects/${projectId}/segments/${id}/members`,
        { limit },
      ),
    enabled: !!projectId && !!id,
    // A materialized segment with no run yet answers 400 rather than an empty
    // page, which is a real answer and not worth retrying into.
    retry: false,
  });
}

/** Event names seen in this project, most frequent first. Populates the picker. */
export function useEventNames(projectId: string | undefined) {
  return useQuery<Array<{ eventName: string; count: number }>>({
    queryKey: ['event-names', projectId],
    queryFn: () =>
      apiGet<Array<{ eventName: string; count: number }>>(
        `/api/projects/${projectId}/events/names`,
      ),
    enabled: !!projectId,
  });
}

// ─── The attribute vocabulary, as the UI needs to present it ───────────────

export type AttributeKind = 'text' | 'number' | 'date' | 'boolean';

/**
 * The profile fields a rule may address, with the type each one needs in the
 * editor. The API owns the mapping from these keys to database columns; this
 * list is only about which keys exist and how to render an input for them.
 *
 * Any other field is addressed as `traits.<key>`, which the API accepts for
 * any custom profile value.
 */
export const ATTRIBUTE_FIELDS: Array<{
  field: string;
  label: string;
  kind: AttributeKind;
}> = [
  { field: 'platform', label: 'Platform', kind: 'text' },
  { field: 'appVersion', label: 'App version', kind: 'text' },
  { field: 'country', label: 'Country', kind: 'text' },
  { field: 'countryCode', label: 'Country code', kind: 'text' },
  { field: 'region', label: 'Region', kind: 'text' },
  { field: 'city', label: 'City', kind: 'text' },
  { field: 'timezone', label: 'Timezone', kind: 'text' },
  { field: 'locale', label: 'Locale', kind: 'text' },
  { field: 'language', label: 'Language', kind: 'text' },
  { field: 'totalSessions', label: 'Total sessions', kind: 'number' },
  { field: 'totalRevenue', label: 'Total revenue', kind: 'number' },
  { field: 'firstSeenAt', label: 'First seen', kind: 'date' },
  { field: 'lastSeenAt', label: 'Last seen', kind: 'date' },
  { field: 'lastEventAt', label: 'Last event', kind: 'date' },
  { field: 'emailOptIn', label: 'Email opt-in', kind: 'boolean' },
  { field: 'pushOptIn', label: 'Push opt-in', kind: 'boolean' },
  { field: 'doNotTrack', label: 'Do not track', kind: 'boolean' },
  { field: 'externalUserId', label: 'User ID', kind: 'text' },
  { field: 'distinctId', label: 'Distinct ID', kind: 'text' },
];

/** Operator labels, written as a marketer reads them rather than as SQL. */
export const OP_LABELS: Record<SegmentAttributeOp, string> = {
  eq: 'is',
  neq: 'is not',
  gt: 'is greater than',
  gte: 'is at least',
  lt: 'is less than',
  lte: 'is at most',
  contains: 'contains',
  in: 'is one of',
  exists: 'is known',
  not_exists: 'is unknown',
};

/** Which operators make sense for a field, so the UI cannot offer nonsense. */
export function opsFor(kind: AttributeKind): SegmentAttributeOp[] {
  switch (kind) {
    case 'number':
    case 'date':
      return ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists'];
    case 'boolean':
      return ['eq', 'exists', 'not_exists'];
    case 'text':
      return ['eq', 'neq', 'contains', 'in', 'exists', 'not_exists'];
  }
}

/** True when the operator takes no value at all. */
export function opTakesNoValue(op: SegmentAttributeOp): boolean {
  return op === 'exists' || op === 'not_exists';
}

export const OCCURRENCE_LABELS: Record<SegmentOccurrence, string> = {
  at_least: 'at least',
  at_most: 'at most',
  exactly: 'exactly',
  none: 'never',
};
