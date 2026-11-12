import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export interface Link {
  id: string;
  shortCode: string;
  longUrl: string;
  title: string;
  tags: string[];
  isActive: boolean;
  expiresAt: string | null;
  iosUrl: string | null;
  androidUrl: string | null;
  iosFallbackUrl: string | null;
  androidFallbackUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImageUrl: string | null;
  deepLinkParams: Record<string, unknown> | null;
  projectId: string;
  project?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  clickCount?: number;
}

export interface LinksResponse {
  data: Link[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface CreateLinkDto {
  longUrl: string;
  /** Optional custom slug (3–30 chars, alphanumerics/dash/underscore). Omit for auto-generated. */
  shortCode?: string;
  title?: string;
  tags?: string[];
  isActive?: boolean;
  expiresAt?: string | null;
  iosUrl?: string | null;
  androidUrl?: string | null;
  iosFallbackUrl?: string | null;
  androidFallbackUrl?: string | null;
  ogTitle?: string | null;
  ogDescription?: string | null;
  ogImageUrl?: string | null;
  deepLinkParams?: Record<string, unknown> | null;
}

export function useLinks(
  projectId?: string,
  search?: string,
  tags?: string[],
  page = 1,
  limit = 20
) {
  const params: Record<string, unknown> = { page, limit };
  if (search) params.search = search;
  if (tags && tags.length > 0) params.tags = tags.join(',');

  return useQuery<LinksResponse>({
    queryKey: ['links', projectId, search, tags, page, limit],
    queryFn: () => apiGet<LinksResponse>(`/api/projects/${projectId}/links`, params),
    enabled: !!projectId,
  });
}

export function useLink(id: string | undefined) {
  return useQuery<Link>({
    queryKey: ['link', id],
    queryFn: () => apiGet<Link>(`/api/links/${id}`),
    enabled: !!id,
  });
}

export function useCreateLink(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateLinkDto) =>
      apiPost<Link>(`/api/projects/${projectId}/links`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['links'] });
    },
  });
}

// shortCode is immutable after creation — callers cannot patch it.
export type UpdateLinkDto = Partial<Omit<CreateLinkDto, 'shortCode'>>;

export function useUpdateLink(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: UpdateLinkDto) =>
      apiPatch<Link>(`/api/links/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['links'] });
      queryClient.invalidateQueries({ queryKey: ['link', id] });
    },
  });
}

export function useDeleteLink() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiDelete(`/api/links/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['links'] });
    },
  });
}

export interface QrCodeResponse {
  qrCode: string;
  format: string;
  shortUrl: string;
}

export function useLinkQrCode(id: string | undefined, format: 'png' | 'svg' = 'png', size = 300) {
  return useQuery<QrCodeResponse>({
    queryKey: ['link-qr', id, format, size],
    queryFn: () => apiGet<QrCodeResponse>(`/api/links/${id}/qr`, { format, size }),
    enabled: !!id,
  });
}

// A/B Link Variants
export interface LinkVariant {
  id: string;
  linkId: string;
  name: string;
  longUrl: string;
  weight: number;
  isActive: boolean;
}

export function useLinkVariants(linkId: string | undefined) {
  return useQuery<LinkVariant[]>({
    queryKey: ['link-variants', linkId],
    queryFn: () => apiGet<LinkVariant[]>(`/api/links/${linkId}/variants`),
    enabled: !!linkId,
  });
}

export function useCreateLinkVariant(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; longUrl: string; weight?: number }) =>
      apiPost<LinkVariant>(`/api/links/${linkId}/variants`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}

export function useUpdateLinkVariant(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ variantId, ...data }: { variantId: string; name?: string; longUrl?: string; weight?: number; isActive?: boolean }) =>
      apiPatch<LinkVariant>(`/api/links/${linkId}/variants/${variantId}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}

export function useDeleteLinkVariant(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (variantId: string) =>
      apiDelete(`/api/links/${linkId}/variants/${variantId}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}
