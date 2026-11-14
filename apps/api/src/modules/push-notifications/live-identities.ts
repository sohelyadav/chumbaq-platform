import type { EntityManager } from 'typeorm';

/**
 * Which of these device identities still exist in the project. A provider's delivery
 * report can arrive after its person was erased; it names them by identity id and can
 * carry the provider's detail text (which may quote the address), so a report for an
 * identity that no longer exists is dropped rather than stored.
 */
export async function liveIdentityIds(manager: EntityManager, projectId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows: Array<{ id: string }> = await manager.query(
    `SELECT id FROM device_identities WHERE project_id = $1 AND id = ANY($2::uuid[])`,
    [projectId, [...new Set(ids)]],
  );
  return new Set(rows.map((row) => row.id));
}
