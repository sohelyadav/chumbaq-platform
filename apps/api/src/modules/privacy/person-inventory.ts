import type { PersonKeys } from './person-scope';

/**
 * Every table that holds data about an app's end user, and what erasure and
 * export do with each. The single list both services walk; the design and the
 * reasoning per table are in
 * docs/superpowers/specs/2026-11-07-person-erasure-export.md.
 *
 * **The structural rule** (trust model): every link the SDK sets is a claim,
 * and `POST /identity/merge` rewrites `distinct_id` across the event tables
 * for any value, so nothing is ever matched by a `distinct_id` or alias id.
 * A row is the person's when:
 *
 * - it names one of their device rows (`device_identity_id`, `$ids`);
 * - it is keyed by one of those devices' own fingerprints (unique per
 *   project, so claiming one means being that device);
 * - an external-id column holds the verified external id (`$externalUserIds`,
 *   empty for an anonymous device);
 * - (erase only) it is keyed by an address only they hold (`$exclusiveEmails`,
 *   `$exclusivePhones`): address history is never exported, since an address
 *   can pass between people.
 *
 * Export shows the rest of that. Erasure also deletes **orphans** (no identity
 * id) whose `distinct_id` is the verified external id: the `orphans` branch,
 * erase-only.
 *
 * Statements are built as `<project> AND (<match>)`, plus `OR (<orphans>)` when
 * erasing, so no branch can escape the project; `$name` tokens are bound by
 * `bindKeys`. Order is erase order: children before parents,
 * `device_identities` last.
 *
 * Adding a table is one entry (see `consent_events` below), placed before
 * `device_identities` if it has a foreign key to it.
 */
export interface InventoryEntry {
  /** The key in erasure counts and export sections; the table, unless `table` says otherwise. */
  name: string;
  /** The table, for a second erase-only entry on a table that already has one. */
  table?: string;
  /** The project predicate: one of `PROJECT_PREDICATES`. */
  project: string;
  /** The person's rows, by the structural rule. */
  match: string;
  /** Narrower rows for export, when some of `match` must not be disclosed. Defaults to `match`. */
  exportMatch?: string;
  /** Erase only: orphan rows keyed by the verified external id. */
  orphans?: string;
  /**
   * `'delete'` deletes the matching rows; a string is a full statement to run
   * instead, ending in `WHERE ${eraseWhere(entry)}`. Absent: not erased here.
   */
  erase?: 'delete' | ((where: string) => string);
  /**
   * Allow-listed columns, so a column added later is not exported until someone decides it should be.
   * `tieBreak` orders equal `orderBy` values (default `id`, for a table that has none).
   */
  export?: { columns: string; orderBy: string; tieBreak?: string };
}

export const PROJECT_PREDICATES = [
  'project_id = $project',
  '"projectId" = $project',
  'link_id IN (SELECT l.id FROM links l WHERE l.project_id = $project)',
] as const;

export function exportWhere(entry: InventoryEntry): string {
  return `${entry.project} AND (${entry.exportMatch ?? entry.match})`;
}

export function eraseWhere(entry: InventoryEntry): string {
  return entry.orphans
    ? `${entry.project} AND ((${entry.match}) OR (${entry.orphans}))`
    : `${entry.project} AND (${entry.match})`;
}

/** A list of snake_case columns as `col AS "camelCase"`. */
export function cols(names: string[]): string {
  return names
    .map((name) => {
      // The last ' AS ' names the column: an expression may contain its own.
      const at = name.lastIndexOf(' AS ');
      const [column, alias] = at >= 0 ? [name.slice(0, at), name.slice(at + 4)] : [name, camel(name)];
      return `${column} AS "${alias.replace(/"/g, '')}"`;
    })
    .join(', ');
}

function camel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

const PROJECT = PROJECT_PREDICATES[0];
const LINK_IN_PROJECT = PROJECT_PREDICATES[2];

/** Orphans keyed by the verified external id (erase only). */
const ORPHAN_BY_EXTERNAL_ID = 'device_identity_id IS NULL AND distinct_id = ANY($externalUserIds)';

/** The person's touchpoints as export shows them: keyed by their devices' own fingerprints. */
const VISIBLE_TOUCHPOINTS = `ARRAY(SELECT t.id::text FROM touchpoints t
  WHERE t.project_id = $project AND t.device_fingerprint = ANY($fingerprints))`;

/** The touchpoints erasure deletes: those, plus orphans under the verified external id. */
const ERASED_TOUCHPOINTS = `ARRAY(SELECT t.id::text FROM touchpoints t
  WHERE t.project_id = $project AND (t.device_fingerprint = ANY($fingerprints) OR t.distinct_id = ANY($externalUserIds)))`;

/** credit_splits with only the entries pointing at the person's visible touchpoints. */
const VISIBLE_SPLITS = `(SELECT COALESCE(jsonb_agg(s ORDER BY n), '[]'::jsonb)
  FROM jsonb_array_elements(CASE WHEN jsonb_typeof(credit_splits) = 'array' THEN credit_splits ELSE '[]'::jsonb END)
    WITH ORDINALITY AS x(s, n)
  WHERE (s->>'touchpointId') = ANY(${VISIBLE_TOUCHPOINTS}))`;

/** The person's conversions, as exported. */
const PERSON_CONVERSIONS = `SELECT c.id FROM conversion_events c
  WHERE c.link_id IN (SELECT l.id FROM links l WHERE l.project_id = $project)
    AND (c.device_identity_id = ANY($ids) OR c.external_user_id = ANY($externalUserIds))`;

/** Removes the person's identity ids from a jsonb array of ids, keeping the rest. */
const withoutIds = (column: string) =>
  `CASE WHEN ${column} ?| $idsText
     THEN COALESCE((SELECT jsonb_agg(e) FROM jsonb_array_elements(${column}) e
                    WHERE NOT ((e #>> '{}') = ANY($idsText))), '[]'::jsonb)
     ELSE ${column} END`;

/**
 * Every value a failure entry's `token` can hold for this person and nobody
 * else: addresses no identity outside the scope holds, and their push tokens
 * (read before push_tokens goes).
 */
const PERSON_RECIPIENT_TOKENS = `(ARRAY(
  SELECT unnest($exclusiveEmails) UNION SELECT unnest($exclusivePhones)
  UNION SELECT t.token::varchar FROM push_tokens t WHERE t.project_id = $project AND t.device_identity_id = ANY($ids)))`;

/** Drops the failure entries addressed to the person, keeping everyone else's. */
const withoutFailuresFor = (column: string) =>
  `CASE WHEN jsonb_typeof(${column}) = 'array'
     THEN COALESCE((SELECT jsonb_agg(f) FROM jsonb_array_elements(${column}) f
                    WHERE NOT COALESCE((f->>'token') = ANY(${PERSON_RECIPIENT_TOKENS}), false)), '[]'::jsonb)
     ELSE ${column} END`;

/**
 * Per-recipient events of push campaigns only. Email, SMS and WhatsApp events
 * describe a mailbox or number, which can pass between people (a changed or
 * freed address, a claimed one, the dedupe picking another identity), so they
 * are not disclosed at all. Erasure still removes them for the person's own
 * devices.
 */
const PUSH_EVENT_OF_PERSON = `push_notification_events.device_identity_id = ANY($ids) AND EXISTS (
    SELECT 1 FROM push_notification_logs l
    WHERE l.id = push_notification_events.campaign_id AND COALESCE(l.channel, 'push') = 'push')`;

export const PERSON_INVENTORY: InventoryEntry[] = [
  {
    // Also cascades from conversion_events; listed first so the count is its own.
    name: 'attribution_results',
    project: PROJECT,
    match: `conversion_id IN (${PERSON_CONVERSIONS})`,
    orphans: 'distinct_id = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      // Splits are snapshots of touchpoints, matched by distinct_id when the
      // conversion was attributed, so a split is shown only when its
      // touchpoint is one this person may see (keyed by their own fingerprint).
      // touchpoint_count is not exported: it counts every split, including
      // the ones withheld above.
      columns: cols(['id', 'conversion_id', 'model', `${VISIBLE_SPLITS} AS creditSplits`, 'lookback_days', 'created_at']),
      orderBy: 'created_at',
    },
  },
  {
    // Attribution rows of other people's conversions can hold snapshots of
    // this person's touchpoints (a merge or an account switch put them under
    // another id before the conversion was attributed): those split entries
    // are removed, the rows stay. Runs before touchpoints are deleted.
    name: 'attribution_credit_splits',
    table: 'attribution_results',
    project: PROJECT,
    match: `jsonb_typeof(credit_splits) = 'array' AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(credit_splits) s WHERE (s->>'touchpointId') = ANY(${ERASED_TOUCHPOINTS}))`,
    erase: (where) => `UPDATE attribution_results
            SET credit_splits = (SELECT COALESCE(jsonb_agg(s ORDER BY n), '[]'::jsonb)
                                 FROM jsonb_array_elements(credit_splits) WITH ORDINALITY AS x(s, n)
                                 WHERE NOT ((s->>'touchpointId') = ANY(${ERASED_TOUCHPOINTS})))
            WHERE ${where}`,
  },
  {
    name: 'conversion_events',
    project: LINK_IN_PROJECT,
    match: 'device_identity_id = ANY($ids) OR external_user_id = ANY($externalUserIds)',
    orphans: ORPHAN_BY_EXTERNAL_ID,
    erase: 'delete',
    export: {
      columns: cols(['id', 'link_id', 'event_type', 'external_user_id', 'metadata', 'converted_at']),
      orderBy: 'converted_at',
    },
  },
  {
    // Deleted, not anonymised: link click totals drop by the person's clicks.
    // Deferred-match state (`matched`) lives on these rows.
    name: 'click_events',
    project: LINK_IN_PROJECT,
    match: 'device_identity_id = ANY($ids)',
    orphans: ORPHAN_BY_EXTERNAL_ID,
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'link_id', 'clicked_at', 'ip_address', 'user_agent', 'referrer', 'platform', 'device_type',
        'os', 'os_version', 'browser', 'browser_version', 'country', 'country_code', 'region', 'city',
        'latitude', 'longitude', 'redirect_type', 'is_deferred', 'matched', 'variant_id',
      ]),
      orderBy: 'clicked_at',
    },
  },
  {
    // No identity column: the device's own fingerprint, or (erase only) the
    // verified external id as distinct_id.
    name: 'touchpoints',
    project: PROJECT,
    match: 'device_fingerprint = ANY($fingerprints)',
    orphans: 'distinct_id = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'touchpoint_type', 'channel', 'campaign', 'utm_source', 'utm_medium', 'utm_campaign', 'utm_term',
        'utm_content', 'link_id', 'referrer', 'platform', 'device_type', 'country', 'city', 'ip_address',
        'metadata', 'touched_at',
      ]),
      orderBy: 'touched_at',
    },
  },
  {
    name: 'user_events',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids)',
    orphans: ORPHAN_BY_EXTERNAL_ID,
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'event_name', 'properties', 'source_type', 'source_id', 'ip_address', 'user_agent', 'platform',
        'country', 'city', 'timestamp',
      ]),
      orderBy: 'timestamp',
    },
  },
  {
    // Per-recipient records for push, email, SMS and WhatsApp campaigns
    // (sent, delivered, impression, click, dismissed, bounced, complained).
    // Campaign counters on push_notification_logs survive as numbers.
    name: 'push_notification_events',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids)',
    exportMatch: PUSH_EVENT_OF_PERSON,
    erase: 'delete',
    export: {
      columns: cols(['id', 'campaign_id', 'type', 'platform', 'occurred_at', 'metadata']),
      orderBy: 'occurred_at',
    },
  },
  {
    // Campaign rows stay; only the person leaves them: their identity ids from
    // the target and control lists, and every failure_details entry whose
    // token is one of their push tokens or an address only they hold. Runs
    // before push_tokens is deleted, which it reads. Not exported: campaign
    // data, not the person's.
    name: 'push_notification_logs',
    project: PROJECT,
    match: `target_device_ids ?| $idsText OR control_device_ids ?| $idsText
      OR (jsonb_typeof(failure_details) = 'array' AND EXISTS (
        SELECT 1 FROM jsonb_array_elements(failure_details) f WHERE (f->>'token') = ANY(${PERSON_RECIPIENT_TOKENS})))`,
    erase: (where) => `UPDATE push_notification_logs
            SET target_device_ids = ${withoutIds('target_device_ids')},
                control_device_ids = ${withoutIds('control_device_ids')},
                failure_details = ${withoutFailuresFor('failure_details')}
            WHERE ${where}`,
  },
  {
    name: 'in_app_message_impressions',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids) OR (device_identity_id IS NULL AND device_fingerprint = ANY($fingerprints))',
    orphans: ORPHAN_BY_EXTERNAL_ID,
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'message_id', 'event_type', 'button_id', 'ip_address', 'user_agent', 'platform', 'country', 'city',
        'created_at',
      ]),
      orderBy: 'created_at',
    },
  },
  {
    name: 'pending_in_app_messages',
    project: PROJECT,
    match: 'device_fingerprint = ANY($fingerprints)',
    orphans: 'distinct_id = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      columns: cols(['id', 'message_id', 'status', 'expires_at', 'created_at']),
      orderBy: 'created_at',
    },
  },
  {
    // An active run is deleted too, which stops the journey for the person.
    // last_error is an internal diagnostic and is not exported.
    name: 'journey_runs',
    project: PROJECT,
    match: 'person_key = ANY($personKeys)',
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'journey_id', 'current_step_index', 'steps_taken', 'status', 'next_due_at', 'created_at',
        'updated_at', 'completed_at',
      ]),
      orderBy: 'created_at',
    },
  },
  {
    name: 'segment_members',
    project: PROJECT,
    match: 'person_key = ANY($personKeys)',
    erase: 'delete',
    export: {
      columns: cols(['id', 'segment_id', 'entered_at', 'materialized_at']),
      orderBy: 'entered_at',
    },
  },
  {
    // Columns are camelCase in this table. The next cohort sync re-adds the member unless the customer erases the
    // person in Mixpanel too.
    name: 'mixpanel_cohort_members',
    project: PROJECT_PREDICATES[1],
    match: '"deviceIdentityId" = ANY($ids)',
    // Only members the sync resolved by the verified external id: one
    // resolved onto this device by a claimed email or distinct id may be
    // someone else (and survives their erasure: a documented residual).
    exportMatch: `"deviceIdentityId" = ANY($ids) AND "resolvedBy" = 'external_user_id' AND "mixpanelDistinctId" = ANY($externalUserIds)`,
    orphans: '"deviceIdentityId" IS NULL AND "mixpanelDistinctId" = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      columns: cols([
        'id',
        '"cohortId" AS cohortId',
        '"resolvedBy" AS resolvedBy',
        '"mixpanelDistinctId" AS mixpanelDistinctId',
        '"mixpanelProfile" AS mixpanelProfile',
        '"addedAt" AS addedAt',
      ]),
      orderBy: '"addedAt"',
    },
  },
  {
    // Erased by ErasedSuppressionsService (kept as keyed hashes), not here,
    // and never exported: a suppression is about an address, which can pass
    // between people. Listed for the inventory's completeness.
    name: 'channel_suppressions',
    project: PROJECT,
    match: `(channel = 'email' AND address = ANY($exclusiveEmails))
        OR (channel IN ('sms', 'whatsapp') AND address = ANY($exclusivePhones))`,
  },
  {
    // The person's own claims: aliases into their verified external id. The
    // anonymous side is withheld in exports when another device holds it.
    name: 'identity_aliases',
    project: PROJECT,
    match: 'identified_id = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      columns: cols(['id', 'anonymous_id', 'identified_id', 'merged_at']),
      orderBy: 'merged_at',
    },
  },
  {
    // The person's consent history (DPDP s.6(10)). Cascades from
    // device_identities; deleted explicitly so it is counted.
    name: 'consent_events',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids)',
    erase: 'delete',
    export: {
      columns: cols(['id', 'device_identity_id', 'channel', 'granted', 'source', 'occurred_at']),
      orderBy: 'occurred_at',
    },
  },
  {
    // A whole-person do-not-track a team member made for the verified
    // external id (empty for an anonymous device, so nothing then). Holds the
    // id itself, so it goes. `created_by` (a team member) and
    // `source_identity_id` (the row it was made from, which may be another
    // device claiming the id) are not the person's data and are not exported;
    // both are SET NULL foreign keys, so nothing here blocks erasing rows.
    name: 'tracking_objections',
    project: PROJECT,
    match: 'external_user_id = ANY($externalUserIds)',
    erase: 'delete',
    export: {
      columns: cols(['external_user_id', 'created_at']),
      orderBy: 'created_at',
      // Keyed by (project, external id): no id column.
      tieBreak: 'external_user_id',
    },
  },
  {
    // Cascades from device_identities; deleted explicitly for the count. The
    // token is a delivery credential for the device, so the export shows only
    // its last six characters.
    name: 'push_tokens',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids)',
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'device_identity_id', "'…' || right(token, 6) AS tokenEnding", 'platform', 'provider', 'is_active',
        'last_used_at', 'deactivated_at', 'deactivation_reason', 'created_at', 'updated_at',
      ]),
      orderBy: 'created_at',
    },
  },
  {
    // The months a device was active, kept for usage counts. No foreign key
    // to the device, so it is deleted here. Daily counts already taken from
    // it hold no id and stay. Dates as text, so no zone can move them.
    name: 'monthly_active_devices',
    project: PROJECT,
    match: 'device_identity_id = ANY($ids)',
    erase: 'delete',
    export: {
      columns: cols([
        'device_identity_id',
        "to_char(month, 'YYYY-MM') AS month",
        "to_char(first_day, 'YYYY-MM-DD') AS firstDay",
      ]),
      orderBy: 'month',
      tieBreak: 'first_day',
    },
  },
  {
    // Profile, device, geo, attribution, engagement, traits and consent.
    name: 'device_identities',
    project: PROJECT,
    match: 'id = ANY($ids)',
    erase: 'delete',
    export: {
      columns: cols([
        'id', 'external_user_id', 'distinct_id', 'device_fingerprint', 'platform', 'user_agent', 'ip_address',
        'traits', 'first_name', 'last_name', 'phone', 'phone_e164', 'email', 'avatar', 'locale', 'language',
        'os', 'os_version', 'browser', 'browser_version', 'app_version', 'app_build', 'manufacturer', 'brand',
        'model', 'screen_height', 'screen_width', 'carrier', 'country', 'country_code', 'region', 'city',
        'timezone', 'latitude', 'longitude', 'initial_referrer', 'initial_referring_domain',
        'initial_utm_source', 'initial_utm_medium', 'initial_utm_campaign', 'initial_utm_content',
        'initial_utm_term', 'install_source', 'install_campaign', 'latest_referrer', 'latest_utm_source',
        'latest_utm_medium', 'latest_utm_campaign', 'total_sessions', 'total_revenue',
        'currency', 'email_opt_in', 'sms_opt_in', 'whatsapp_opt_in', 'push_opt_in', 'gdpr_consent',
        'do_not_track', 'do_not_track_source', 'consent_updated_at', 'first_seen_at',
        // Every writer of these two is per row now (updateLastEventAt stamps
        // the device an event names; merge keeps last_seen_at; identify,
        // updateLastSeen and revenue write their own row), so neither can
        // carry someone else's activity time.
        'last_event_at', 'last_seen_at',
      ]),
      orderBy: 'first_seen_at',
    },
  },
];

/** Postgres type of each token, so unused-type inference never fails. */
const TOKEN_TYPES: Record<string, { type: string; value: (k: PersonKeys) => unknown }> = {
  project: { type: 'uuid', value: (k) => k.projectId },
  ids: { type: 'uuid[]', value: (k) => k.identityIds },
  idsText: { type: 'text[]', value: (k) => k.identityIds },
  fingerprints: { type: 'varchar[]', value: (k) => k.fingerprints },
  externalUserIds: { type: 'varchar[]', value: (k) => k.externalUserIds },
  personKeys: { type: 'varchar[]', value: (k) => k.personKeys },
  exclusiveEmails: { type: 'varchar[]', value: (k) => k.exclusiveEmails },
  exclusivePhones: { type: 'varchar[]', value: (k) => k.exclusivePhones },
};

export const INVENTORY_TOKENS = Object.keys(TOKEN_TYPES);

/**
 * Replaces `$name` tokens with typed positional parameters (`$1::uuid`), in
 * order of first use, and returns the values to bind. Only the tokens a
 * statement uses are bound. An unknown token throws: a typo must not become a
 * predicate that silently matches nothing.
 */
export function bindKeys(
  sql: string,
  keys: PersonKeys,
  extra: unknown[] = [],
): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const positions = new Map<string, number>();
  const bound = sql.replace(/\$([a-zA-Z]+)\b/g, (whole: string, token: string) => {
    if (token === 'extra') return whole;
    const spec = TOKEN_TYPES[token];
    if (!spec) throw new Error(`Unknown inventory token $${token}`);
    let position = positions.get(token);
    if (position === undefined) {
      params.push(spec.value(keys));
      position = params.length;
      positions.set(token, position);
    }
    return `$${position}::${spec.type}`;
  });
  // Extra parameters (a LIMIT) follow the tokens.
  let next = params.length;
  const withExtra = bound.replace(/\$extra\b/g, () => `$${++next}`);
  return { sql: withExtra, params: [...params, ...extra] };
}

/** The statement that erases one entry, or null if it is not erased here. */
export function eraseStatement(entry: InventoryEntry, keys: PersonKeys) {
  if (!entry.erase) return null;
  const where = eraseWhere(entry);
  const sql = entry.erase === 'delete' ? `DELETE FROM ${entry.table ?? entry.name} WHERE ${where}` : entry.erase(where);
  return bindKeys(sql, keys);
}

/** Row and count queries for one entry's export section, or null if not exported. */
export function exportStatements(entry: InventoryEntry, keys: PersonKeys, limit: number) {
  if (!entry.export) return null;
  const where = exportWhere(entry);
  return {
    rows: bindKeys(
      `SELECT ${entry.export.columns} FROM ${entry.name} WHERE ${where}
       ORDER BY ${entry.export.orderBy} DESC NULLS LAST, ${entry.export.tieBreak ?? 'id'} DESC LIMIT $extra`,
      keys,
      [limit],
    ),
    count: bindKeys(`SELECT COUNT(*)::int AS total FROM ${entry.name} WHERE ${where}`, keys),
  };
}
