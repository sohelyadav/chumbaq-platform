import type { PrivacySubject } from '@chumbaq/shared';
import type { ActivityActor } from '../project-activity/project-activity.service';
import type { PersonKeys } from './person-scope';

/**
 * Who made a privacy request: a dashboard user or a server API key. The key's name
 * is for the activity log's actor label only; `privacy_request_logs` keeps the id.
 */
export type PrivacyActor =
  | { type: 'user'; id: string }
  | { type: 'api_key'; id: string; name: string };

/** The activity log's actor for a privacy request. */
export function activityActorOf(actor: PrivacyActor): ActivityActor {
  return actor.type === 'user'
    ? { kind: 'user', userId: actor.id }
    : { kind: 'api_key', keyId: actor.id, keyName: actor.name };
}

/**
 * The person an erasure or export acted on, as the activity log names them: by
 * internal id (a `device_identities` row id) only, with no label. Never the external
 * id, fingerprint or an address the request may have named them by.
 *
 * The dashboard names a row, which is the id when it was found. The server API names
 * an external id or a fingerprint, so the id is the first of the rows found for it
 * (they are in id order). A request that found no row has no id to give: `null`.
 */
export function personTarget(
  subject: PrivacySubject,
  keys: Pick<PersonKeys, 'identityIds'>,
): { type: 'person'; id: string | null; label: null } {
  const id =
    subject.type === 'personId'
      ? keys.identityIds.includes(subject.value)
        ? subject.value
        : null
      : (keys.identityIds[0] ?? null);
  return { type: 'person', id, label: null };
}
