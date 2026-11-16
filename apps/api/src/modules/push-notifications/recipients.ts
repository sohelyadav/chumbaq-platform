import { EntityManager } from 'typeorm';

/**
 * Who a campaign or a count is for, when it is not the whole project.
 *
 * - `devices`: a short list known in memory (one person's devices, a test send, a
 *   journey step, a list picked in the dashboard). Filtered to the project wherever
 *   it is used, since it may come from a request.
 * - `query`: a sub-select of device ids, with named parameters (a segment). Never
 *   loaded into memory, so it has no size limit. Only ever stored or staged, never
 *   embedded in a reader: as an `IN (...)` beside a filter on a project the table's
 *   statistics do not know yet, the planner may run it once per row.
 * - `campaign`: the `target` rows stored for a campaign in `campaign_recipients`.
 * - `staged`: the rows `stageRecipients` put in this transaction's temporary table.
 *
 * An empty `devices` list reaches nobody; it must never widen to the project.
 */
export type Recipients =
  | { kind: 'devices'; ids: string[] }
  | { kind: 'query'; sql: string; params: Record<string, unknown> }
  | { kind: 'campaign'; campaignId: string }
  | { kind: 'staged' };

export const STAGED: Recipients = { kind: 'staged' };

export function deviceList(ids: string[]): Recipients {
  return { kind: 'devices', ids };
}

export function storedRecipients(campaignId: string): Recipients {
  return { kind: 'campaign', campaignId };
}

/**
 * A condition limiting `column` (a device identity id) to the recipients, with its
 * named parameters, or null when they are nobody. The parameter names are fixed, so
 * one query may use the same recipients twice. Every form is an index probe or a
 * small set, so a reader stays linear however stale the statistics are.
 */
export function recipientsCondition(
  column: string,
  recipients: Recipients,
): { sql: string; params: Record<string, unknown> } | null {
  if (recipients.kind === 'devices') {
    if (recipients.ids.length === 0) return null;
    return { sql: `${column} = ANY(:recipientIds::uuid[])`, params: { recipientIds: recipients.ids } };
  }
  if (recipients.kind === 'staged') {
    return { sql: `${column} IN (SELECT sr.id FROM staged_recipients sr)`, params: {} };
  }
  if (recipients.kind === 'campaign') {
    return {
      sql: `${column} IN (SELECT cr.device_identity_id FROM campaign_recipients cr
                           WHERE cr.campaign_id = :recipientCampaignId AND cr.role = 'target')`,
      params: { recipientCampaignId: recipients.campaignId },
    };
  }
  throw new Error('A segment is stored or staged before it is read');
}

/**
 * The recipients' device ids as a SELECT of one column, `id`, limited to the project,
 * driving the statement it feeds (so nothing is run once per row).
 */
function recipientsSource(projectId: string, recipients: Recipients): { sql: string; params: Record<string, unknown> } | null {
  if (recipients.kind === 'devices') {
    if (recipients.ids.length === 0) return null;
    return {
      sql: `SELECT d.id FROM device_identities d
             WHERE d.project_id = :sourceProjectId AND d.id = ANY(:recipientIds::uuid[])`,
      params: { sourceProjectId: projectId, recipientIds: recipients.ids },
    };
  }
  if (recipients.kind === 'query') {
    // A segment's query reads only this project's rows already.
    return { sql: `SELECT q.id FROM (${recipients.sql}) q`, params: recipients.params };
  }
  if (recipients.kind === 'staged') {
    return { sql: `SELECT sr.id FROM staged_recipients sr`, params: {} };
  }
  return {
    sql: `SELECT cr.device_identity_id AS id FROM campaign_recipients cr
            JOIN device_identities d ON d.id = cr.device_identity_id AND d.project_id = :sourceProjectId
           WHERE cr.campaign_id = :sourceCampaignId AND cr.role = 'target'`,
    params: { sourceProjectId: projectId, sourceCampaignId: recipients.campaignId },
  };
}

async function scalar(manager: EntityManager, sql: string, params: Record<string, unknown>): Promise<number> {
  const [text, values] = manager.connection.driver.escapeQueryWithParameters(sql, params, {});
  const [{ n }] = (await manager.query(text, values)) as Array<{ n: number }>;
  return n;
}

/**
 * Stores who a new campaign is for, in the caller's transaction, as `target` rows.
 * Only devices of the campaign's project are written, whatever the source names.
 * Returns how many devices that is.
 */
export async function storeRecipients(
  manager: EntityManager,
  campaign: { id: string; projectId: string },
  recipients: Recipients,
): Promise<number> {
  const source = recipientsSource(campaign.projectId, recipients);
  if (!source) return 0;
  return scalar(
    manager,
    `WITH stored AS (
       INSERT INTO campaign_recipients (campaign_id, role, device_identity_id)
       SELECT :storeCampaignId::uuid, 'target', s.id FROM (${source.sql}) s
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM stored`,
    { ...source.params, storeCampaignId: campaign.id },
  );
}

/**
 * Puts the recipients' devices in a temporary table for the rest of the caller's
 * transaction (it must be one), with fresh statistics, so the readers can count
 * against `STAGED` on that transaction's manager. Returns how many devices.
 */
export async function stageRecipients(
  manager: EntityManager,
  projectId: string,
  recipients: Recipients,
): Promise<number> {
  await manager.query(`CREATE TEMP TABLE staged_recipients (id uuid PRIMARY KEY) ON COMMIT DROP`);
  const source = recipientsSource(projectId, recipients);
  if (!source) return 0;
  const n = await scalar(
    manager,
    `WITH staged AS (
       INSERT INTO staged_recipients (id) SELECT s.id FROM (${source.sql}) s
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS n FROM staged`,
    source.params,
  );
  await manager.query(`ANALYZE staged_recipients`);
  return n;
}

/** One stored recipient row. */
export interface RecipientRow {
  campaignId: string;
  role: 'target' | 'control';
  deviceIdentityId: string;
}

/** Writes recipient rows in one statement (a page of a split), in the caller's transaction. */
export async function insertRecipientRows(manager: EntityManager, rows: RecipientRow[]): Promise<void> {
  if (rows.length === 0) return;
  await manager.query(
    `INSERT INTO campaign_recipients (campaign_id, role, device_identity_id)
     SELECT * FROM unnest($1::uuid[], $2::varchar[], $3::uuid[])
     ON CONFLICT DO NOTHING`,
    [rows.map((r) => r.campaignId), rows.map((r) => r.role), rows.map((r) => r.deviceIdentityId)],
  );
}

/** Gives a new campaign the same `target` recipients as another (a recurring template's occurrence). */
export async function copyRecipients(manager: EntityManager, fromCampaignId: string, toCampaignId: string): Promise<void> {
  await manager.query(
    `INSERT INTO campaign_recipients (campaign_id, role, device_identity_id)
     SELECT $2, 'target', device_identity_id FROM campaign_recipients
      WHERE campaign_id = $1 AND role = 'target'
     ON CONFLICT DO NOTHING`,
    [fromCampaignId, toCampaignId],
  );
}

/**
 * Counts with `count`, which reads the recipients it is given (on the manager when it
 * is given one). A segment is staged first, in a transaction of its own, so the count
 * runs against a small indexed table rather than the segment's query.
 */
export async function countRecipientsBy(
  manager: EntityManager,
  projectId: string,
  recipients: Recipients | null,
  count: (recipients: Recipients | null, manager?: EntityManager) => Promise<number>,
): Promise<number> {
  if (recipients?.kind !== 'query') return count(recipients);
  return manager.transaction(async (transaction) => {
    await stageRecipients(transaction, projectId, recipients);
    return count(STAGED, transaction);
  });
}
