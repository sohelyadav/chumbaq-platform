import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, apiPatch, apiDelete } from '@/lib/api';

export interface LinkVariant {
  id: string;
  linkId: string;
  name: string;
  longUrl: string;
  iosUrl: string | null;
  androidUrl: string | null;
  weight: number;
  clicks: number;
  conversions: number;
  createdAt: string;
  updatedAt: string;
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
    mutationFn: (data: { name: string; longUrl: string; iosUrl?: string; androidUrl?: string; weight?: number }) =>
      apiPost<LinkVariant>(`/api/links/${linkId}/variants`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}

export function useUpdateLinkVariant(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; name?: string; longUrl?: string; weight?: number }) =>
      apiPatch<LinkVariant>(`/api/links/${linkId}/variants/${id}`, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}

export function useDeleteLinkVariant(linkId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiDelete(`/api/links/${linkId}/variants/${id}`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['link-variants', linkId] });
    },
  });
}
