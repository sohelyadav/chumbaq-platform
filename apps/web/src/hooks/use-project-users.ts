import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

/**
 * One row of the project's user list.
 *
 * A row is a *device identity*, not a person: a user on three devices has
 * three rows, each reporting the same `distinctId` and a `deviceCount` of 3.
 * `id` is therefore what push targeting wants — it is the identity a token
 * hangs off — while `distinctId` is what reaches everything that user owns.
 */
export interface ProjectUser {
  id: string;
  distinctId: string;
  externalUserId: string | null;
  displayName: string;
  email: string | null;
  platform: string | null;
  country: string | null;
  deviceCount: number;
  lastSeenAt: string | null;
  /** Whether this identity holds at least one active push token. */
  pushEnabled: boolean;
  status: 'active' | 'inactive';
}

export interface ProjectUsersPage {
  data: ProjectUser[];
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export interface ProjectUsersQuery {
  search?: string;
  /** Narrow to identities that can actually receive a push. */
  pushEnabled?: boolean;
  page?: number;
  limit?: number;
}

/**
 * Searches the project's users, for pickers that target specific devices.
 *
 * Paged rather than fetch-everything: a real project has more identities than
 * a dropdown can hold, and the server already filters by search and by
 * whether the identity is reachable at all.
 */
export function useProjectUsers(
  projectId: string | undefined,
  query: ProjectUsersQuery = {},
  enabled = true,
) {
  const { search, pushEnabled, page = 1, limit = 20 } = query;

  return useQuery<ProjectUsersPage>({
    queryKey: ['project-users', projectId, search, pushEnabled, page, limit],
    queryFn: () => {
      const params = new URLSearchParams({
        page: String(page),
        limit: String(limit),
      });
      if (search) params.set('search', search);
      if (pushEnabled !== undefined) params.set('pushEnabled', String(pushEnabled));
      return apiGet<ProjectUsersPage>(
        `/api/projects/${projectId}/users?${params.toString()}`,
      );
    },
    enabled: !!projectId && enabled,
    // The picker re-queries on every keystroke-debounce; keeping the previous
    // page visible avoids the list blanking between results.
    placeholderData: (previous) => previous,
  });
}
