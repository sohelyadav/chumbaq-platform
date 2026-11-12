import { ConflictException } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { PrivacySubject } from '@chumbaq/shared';

/** Past this many `device_identities` rows for one person, the request is refused: one person does not have that many devices. */
export const MAX_DEVICES_PER_PERSON = 100;

export const SIGNED_IN_DEVICE_MESSAGE =
  'This device belongs to a signed-in user; erase or export by externalUserId.';

/** What erasure leaves on purpose, said in every response so nobody assumes otherwise. */
export const NOT_ERASED = [
  'Other devices that are not signed in as this user, and events recorded under their ids or under ids never linked to this user (anonymous ids before sign-in, earlier ids)',
  'History recorded on a shared device before this user signed in: it goes with the device, not the user',
  'Opt-outs, kept as one-way hashes so the person is not messaged again if their address is added later',
  'Mixpanel cohort membership, which comes back at the next cohort sync unless you delete the person in Mixpanel too',
  'Campaign totals, as anonymous numbers',
  'A log entry recording this request, with their ids stored only as keyed hashes',
  'An opt-out or delivery failure for an address another record in this project also holds, kept as it is',
  'Database backups until they expire, and application logs',
  'Data already sent to your providers and tools (FCM, APNs, SES, Resend, Brevo, Twilio, Meta, Gupshup, Interakt, Mixpanel, webhooks)',
];

interface ScopeRow {
  id: string;
  device_fingerprint: string;
  external_user_id: string | null;
  email: string | null;
  phone_e164: string | null;
}

/** Everything every inventory statement keys on. All scoped to `projectId`. */
export interface PersonKeys {
  projectId: string;
  /** The person's `device_identities` rows. Rows naming one of them are theirs. */
  identityIds: string[];
  /** Those rows' own fingerprints: unique per project, so a row keyed by one is that device's. */
  fingerprints: string[];
  /** The verified external id, or none (an anonymous device). Never more than one. */
  externalUserIds: string[];
  /** `COALESCE(external_user_id, 'device:' || id)`, as segments and journeys key a person. */
  personKeys: string[];
  emails: string[];
  phones: string[];
  /** Addresses no identity outside the scope holds: only these key address-shaped rows. */
  exclusiveEmails: string[];
  exclusivePhones: string[];
}

/**
 * Finds the `device_identities` rows of the person `subject` names in this
 * project, and the keys the other tables use for them.
 *
 * **Trust model.** Everything that links identities is set with the API key
 * that ships inside every app: `distinct_id` on events and devices,
 * `POST /identity/merge` (which rewrites `distinct_id` across the event
 * tables for any value, with no proof of the device), and `external_user_id`
 * on a device. So no row is ever matched by a `distinct_id` or alias id,
 * except orphan rows whose `distinct_id` is the verified external id, and
 * only for erasure. Design: docs/superpowers/specs/2026-11-07-person-erasure-export.md.
 *
 * - `externalUserId` X (server API): the rows with that external id. X is verified.
 * - `personId` (dashboard, the owner acting on their own data): that row; if
 *   it has an external id E, every row with E, and E is verified.
 * - `deviceFingerprint` (server API): a device with an external id (set by
 *   the SDK, so unverified) is refused with 409; an anonymous one is that row,
 *   with no verified id.
 *
 * With `lock`, the rows are locked FOR UPDATE in one statement, in id order,
 * so two erasures reaching the same rows by different subjects cannot
 * deadlock, and an identify for those devices waits and then finds them gone.
 */
export async function resolvePersonScope(
  manager: EntityManager,
  projectId: string,
  subject: PrivacySubject,
  options: { lock: boolean },
): Promise<PersonKeys> {
  // A dashboard person's external id is read before the rows are locked; if
  // an identify changed it in between, resolve again from the locked row.
  let scope = await attempt(manager, projectId, subject, options);
  if (scope === 'anchor-changed') scope = await attempt(manager, projectId, subject, options);
  if (scope === 'anchor-changed') {
    throw new ConflictException('This person changed while being resolved. Nothing was changed. Try again.');
  }
  return scope;
}

async function attempt(
  manager: EntityManager,
  projectId: string,
  subject: PrivacySubject,
  options: { lock: boolean },
): Promise<PersonKeys | 'anchor-changed'> {
  const columns = 'id, device_fingerprint, external_user_id, email, phone_e164';

  let anchorId: string | null = null;
  let verified: string | null = null;
  if (subject.type === 'externalUserId') {
    verified = subject.value;
  } else {
    // personId arrives validated as a UUID (ParseUUIDPipe).
    const predicate = subject.type === 'personId' ? 'id = $2::uuid' : 'device_fingerprint = $2';
    // Both keys are unique per project; LIMIT 2 and the check below keep that
    // an assumption the code refuses to act without, not one it relies on.
    const anchors: ScopeRow[] = await manager.query(
      `SELECT ${columns} FROM device_identities WHERE project_id = $1 AND ${predicate} LIMIT 2`,
      [projectId, subject.value],
    );
    if (anchors.length > 1) {
      throw new ConflictException('More than one device matches. Nothing was changed. Contact support.');
    }
    const [anchor] = anchors;
    if (anchor) {
      if (anchor.external_user_id !== null && subject.type === 'deviceFingerprint') {
        throw new ConflictException(SIGNED_IN_DEVICE_MESSAGE);
      }
      anchorId = anchor.id;
      verified = anchor.external_user_id;
    }
  }

  const rows: ScopeRow[] =
    anchorId === null && verified === null
      ? []
      : await manager.query(
          `SELECT ${columns} FROM device_identities
           WHERE project_id = $1 AND (id = ANY($2::uuid[]) OR external_user_id = $3)
           ORDER BY id
           LIMIT ${MAX_DEVICES_PER_PERSON + 1}${options.lock ? ' FOR UPDATE' : ''}`,
          [projectId, anchorId ? [anchorId] : [], verified],
        );
  if (rows.length > MAX_DEVICES_PER_PERSON) {
    throw new ConflictException(
      `This person has more than ${MAX_DEVICES_PER_PERSON} devices in this project. Nothing was changed. Contact support.`,
    );
  }

  // Lock the devices' push tokens too, before the erasure touches any campaign
  // row: a campaign batch appending failures takes FOR KEY SHARE on push
  // tokens and then waits for its campaign row, so an erasure that locked the
  // campaign row first and the tokens only when deleting them could deadlock
  // with it.
  if (options.lock && rows.length > 0) {
    await manager.query(
      // In token order: the order the (project_id, token) index gives, and the
      // order markTokensInvalid's token = ANY(...) takes them in.
      'SELECT id FROM push_tokens WHERE project_id = $1 AND device_identity_id = ANY($2::uuid[]) ORDER BY token FOR UPDATE',
      [projectId, rows.map((r) => r.id)],
    );
  }

  if (anchorId !== null && subject.type === 'personId') {
    const locked = rows.find((r) => r.id === anchorId);
    if (locked && locked.external_user_id !== verified) return 'anchor-changed';
  }

  // A device that changed hands between the two reads is not trusted either way.
  if (subject.type === 'deviceFingerprint' && rows.some((r) => r.external_user_id !== null)) {
    throw new ConflictException(SIGNED_IN_DEVICE_MESSAGE);
  }

  const emails = unique(rows.map((r) => r.email));
  const phones = unique(rows.map((r) => r.phone_e164));
  const held: Array<{ email: string | null; phone_e164: string | null }> =
    emails.length + phones.length > 0
      ? await manager.query(
          `SELECT email, phone_e164 FROM device_identities
           WHERE project_id = $1 AND NOT (id = ANY($2::uuid[]))
             AND (email = ANY($3::varchar[]) OR phone_e164 = ANY($4::varchar[]))`,
          [projectId, rows.map((r) => r.id), emails, phones],
        )
      : [];
  const externalUserIds = unique([verified]);

  return {
    projectId,
    identityIds: rows.map((r) => r.id),
    fingerprints: unique(rows.map((r) => r.device_fingerprint)),
    externalUserIds,
    personKeys: unique([...externalUserIds, ...rows.map((r) => `device:${r.id}`)]),
    emails,
    phones,
    exclusiveEmails: emails.filter((e) => !held.some((h) => h.email === e)),
    exclusivePhones: phones.filter((p) => !held.some((h) => h.phone_e164 === p)),
  };
}

/** True when nothing anywhere could be keyed on: the sweep would match no row. */
export function isEmptyScope(keys: PersonKeys): boolean {
  return keys.identityIds.length === 0 && keys.externalUserIds.length === 0;
}

function unique(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length > 0))];
}
