import { hideFields } from '../../common/impersonation-redaction';
import type { ProjectAccess } from './project-access.service';

/**
 * Hides `fields` from anyone who may not read this project's secrets: staff viewing as
 * the tenant, and any role without `channels.manage`. Hidden exactly as
 * `redactForImpersonator` hides them (`HIDDEN_DURING_IMPERSONATION`, objects keep their
 * keys), so the settings pages read one shape.
 */
export function redactSecrets<T extends object>(body: T, access: ProjectAccess, fields: string[]): T {
  if (!access.impersonated && access.can('channels.manage')) return body;
  return hideFields(body, fields);
}
