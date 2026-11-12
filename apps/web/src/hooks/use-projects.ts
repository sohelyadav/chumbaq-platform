import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';
import type { ProjectListMeta, ProjectPermission, ProjectRole } from '@chumbaq/shared';

export interface Project {
  id: string;
  name: string;
  domain: string;
  iosBundleId: string | null;
  iosAppStoreUrl: string | null;
  iosTeamId: string | null;
  iosAppStoreId: string | null;
  androidPackageName: string | null;
  androidPlayStoreUrl: string | null;
  androidSha256Fingerprints: string | null;
  webFallbackUrl: string | null;
  ownerId: string;
  /** The caller's role in this project. */
  role: ProjectRole;
  /** The project is billed to the caller. */
  isBillingOwner: boolean;
  /** What the caller's role may do here: read through `can` in `lib/project-role.ts`. */
  permissions: ProjectPermission[];
  createdAt: string;
  updatedAt: string;
  linkCount?: number;
}

export interface CreateProjectDto {
  name: string;
  domain: string;
  iosBundleId?: string | null;
  iosAppStoreUrl?: string | null;
  iosTeamId?: string | null;
  iosAppStoreId?: string | null;
  androidPackageName?: string | null;
  androidPlayStoreUrl?: string | null;
  androidSha256Fingerprints?: string | null;
  webFallbackUrl?: string | null;
}

export interface ProjectsResponse {
  data: Project[];
  /**
   * `projectLimit`: how many projects the account may own; `billedProjects`: how many it
   * owns (billed to it), which is what the limit counts. `total` is every project listed.
   */
  meta: ProjectListMeta;
}

export function useProjects() {
  return useQuery<ProjectsResponse>({
    queryKey: ['projects'],
    queryFn: () => apiGet<ProjectsResponse>('/api/projects'),
  });
}

export function useProject(id: string | undefined) {
  return useQuery<Project>({
    queryKey: ['project', id],
    queryFn: () => apiGet<Project>(`/api/projects/${id}`),
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateProjectDto) => apiPost<Project>('/api/projects', data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

export function useUpdateProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<CreateProjectDto>) =>
      apiPatch<Project>(`/api/projects/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      queryClient.invalidateQueries({ queryKey: ['project', id] });
    },
  });
}

export function useDeleteProject(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => apiDelete(`/api/projects/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}
