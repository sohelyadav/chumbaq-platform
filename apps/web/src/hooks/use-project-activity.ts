import { useInfiniteQuery } from '@tanstack/react-query';
import type { ProjectActivityPage } from '@chumbaq/shared';
import api, { apiGet } from '@/lib/api';
import { activityQueryParams, type ActivityFilters } from '@/lib/activity-sentence';

/**
 * A project's activity log (`modules/project-activity`), newest first, 50 at a time.
 * Needs `activity.view`; pass `enabled: false` for anyone without it.
 */
export function useProjectActivity(projectId: string | undefined, filters: ActivityFilters, enabled: boolean) {
  const params = activityQueryParams(filters);
  return useInfiniteQuery<ProjectActivityPage>({
    queryKey: ['project-activity', projectId, params],
    queryFn: ({ pageParam }) =>
      apiGet<ProjectActivityPage>(`/api/projects/${projectId}/activity`, {
        ...params,
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: !!projectId && enabled,
  });
}

/** The API's message in a failed blob request, whose body arrives as a Blob, not JSON. */
async function blobErrorMessage(err: unknown): Promise<string | null> {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!(data instanceof Blob)) return null;
  try {
    const body = JSON.parse(await data.text()) as { message?: unknown };
    return typeof body.message === 'string' && body.message ? body.message : null;
  } catch {
    return null;
  }
}

/** The file name the API gave in Content-Disposition, if it can be read. */
function fileNameOf(disposition: unknown, fallback: string): string {
  if (typeof disposition !== 'string') return fallback;
  const match = /filename="([^"]+)"/.exec(disposition);
  return match?.[1] ?? fallback;
}

/**
 * Downloads the log as CSV with the page's filters, through the signed-in API client (the
 * token travels in the header, never in a URL). Resolves with `null` on success, or the
 * API's refusal (over 50,000 rows, view-as) for the page to show.
 */
export async function downloadActivityCsv(projectId: string, filters: ActivityFilters): Promise<string | null> {
  try {
    const response = await api.get(`/api/projects/${projectId}/activity/export`, {
      params: activityQueryParams(filters),
      responseType: 'blob',
    });
    const url = URL.createObjectURL(new Blob([response.data], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileNameOf(response.headers['content-disposition'], `activity-${projectId}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Some browsers start the download after click() returns; revoking at once can cancel it.
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return null;
  } catch (err) {
    return (await blobErrorMessage(err)) ?? 'The download did not start. Try again.';
  }
}
