import api from '@/lib/api';

export interface ExportResult {
  rowCount: number;
  rowCap: number;
  truncated: boolean;
}

/**
 * Downloads a CSV export through the signed-in client, since a plain link would carry
 * no token, and reads the row counts the API sends alongside it.
 */
export async function downloadExport(
  path: string,
  params: Record<string, string>,
  fallbackFilename: string,
): Promise<ExportResult> {
  const response = await api.get<Blob>(path, { params, responseType: 'blob' });
  const disposition = String(response.headers['content-disposition'] ?? '');
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackFilename;
  const url = URL.createObjectURL(response.data);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  // Once the click has started the download, which holds its own reference.
  setTimeout(() => URL.revokeObjectURL(url), 0);
  return {
    rowCount: Number(response.headers['x-export-row-count'] ?? 0),
    rowCap: Number(response.headers['x-export-row-cap'] ?? 0),
    truncated: response.headers['x-export-truncated'] === 'true',
  };
}
