import { BadRequestException } from '@nestjs/common';
import type { ApiKeyPermission } from '@chumbaq/shared';

/**
 * What an API key may be granted.
 *
 * API keys are the same keys that ship inside every client app, so until
 * `privacy` existed the column was stored and never read: anything a key could
 * reach, anyone who unpacked an app could reach. `privacy` (erase and export a
 * person) is the first permission enforced, and it is deliberately
 * server-only:
 *
 * - never in the default set, so it has to be chosen when the key is made;
 * - a privacy key holds `privacy` and nothing else;
 * - every SDK route refuses it (`ApiKeyGuard`), so a developer who ships one
 *   in an app finds out at once instead of shipping a key that can erase or
 *   export anyone.
 */
export const API_KEY_PERMISSIONS: readonly ApiKeyPermission[] = ['read', 'write', 'privacy'];

export const PRIVACY_PERMISSION: ApiKeyPermission = 'privacy';

export const DEFAULT_API_KEY_PERMISSIONS: ApiKeyPermission[] = ['read', 'write'];

/** A key that only server code may use. Null and older rows are not. */
export function isServerOnlyKey(permissions: string[] | null | undefined): boolean {
  return Array.isArray(permissions) && permissions.includes(PRIVACY_PERMISSION);
}

/**
 * The permissions a new key is stored with. Refuses a set that mixes
 * `privacy` with anything else: a key an SDK may use must never also be able
 * to erase people.
 */
export function permissionsForNewKey(requested: string[] | undefined): ApiKeyPermission[] {
  if (requested === undefined) return [...DEFAULT_API_KEY_PERMISSIONS];
  const unique = [...new Set(requested)] as ApiKeyPermission[];
  if (unique.includes(PRIVACY_PERMISSION) && unique.length > 1) {
    throw new BadRequestException(
      'A privacy key is for servers only and cannot also have read or write. Create a separate key for your app.',
    );
  }
  return unique;
}
