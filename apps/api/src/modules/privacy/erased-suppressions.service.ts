import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import type { MessageChannel } from '../push-notifications/message-channel';
import { PrivacyHashService } from './privacy-hash.service';

/** `channel_suppressions.source` for a suppression brought back by `restore`. */
export const RESTORED_SUPPRESSION_SOURCE = 'erasure';

/** The channels an address of each kind is suppressed under. */
const EMAIL_CHANNELS: MessageChannel[] = ['email'];
const PHONE_CHANNELS: MessageChannel[] = ['sms', 'whatsapp'];

export interface PersonAddresses {
  /** Normalised (`device_identities.email`). */
  emails: string[];
  /** E.164 (`device_identities.phone_e164`). */
  phones: string[];
}

interface AddressKey {
  channel: MessageChannel;
  address: string;
  hash: string;
}

/**
 * Keeps an erased person's suppressions alive without keeping their addresses.
 *
 * `hashPersonSuppressions` (inside the erasure transaction) deletes the clear
 * `channel_suppressions` rows for the person's addresses, except where an
 * identity outside the erased scope still holds the address (then the clear
 * row is that other record's and keeps working), and stores each row it
 * actually deleted as a keyed hash in `erased_suppressions`. A kept clear row
 * gets no hash: a later resubscribe that lifts it must not be undone by a
 * hash restoring it.
 *
 * `restore` is the other half: `IdentityService.identify`, the only writer of
 * `device_identities.email` and `phone_e164`, calls it in its own transaction
 * before storing a new or changed address. A matching hash becomes a clear
 * suppression again and the hash is dropped, so every existing suppression
 * check (the SQL in `AddressAudience`, the webhooks, START/STOP) honours it
 * without knowing that erasure exists. Any new writer of those two columns
 * must call it too.
 *
 * **The two are serialised per address**: both take
 * `pg_advisory_xact_lock` on each (project, channel, address) key, in sorted
 * order so neither can deadlock the other, and hold it to their commit.
 * Either the identify commits first, and the erasure then sees an identity
 * outside its scope holding the address and keeps the clear row, or the
 * erasure commits first, and the identify's restore then finds the hash.
 */
@Injectable()
export class ErasedSuppressionsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly hashes: PrivacyHashService,
  ) {}

  async hashPersonSuppressions(
    manager: EntityManager,
    projectId: string,
    scopeIdentityIds: string[],
    addresses: PersonAddresses,
  ): Promise<{ kept: number; clearRowsDeleted: number }> {
    const keys = this.keysFor(projectId, addresses.emails, addresses.phones);
    if (keys.length === 0) return { kept: 0, clearRowsDeleted: 0 };
    await this.lock(manager, projectId, keys);

    const deleted: Array<{ channel: MessageChannel; address: string; reason: string }> = rowsOf(
      await manager.query(
        `DELETE FROM channel_suppressions s
         WHERE s.project_id = $1
           AND ((s.channel = ANY($2::varchar[]) AND s.address = ANY($3::varchar[]))
             OR (s.channel = ANY($4::varchar[]) AND s.address = ANY($5::varchar[])))
           AND NOT EXISTS (
             SELECT 1 FROM device_identities d
             WHERE d.project_id = $1
               AND NOT (d.id = ANY($6::uuid[]))
               AND ((s.channel = ANY($2::varchar[]) AND d.email = s.address)
                 OR (s.channel = ANY($4::varchar[]) AND d.phone_e164 = s.address)))
         RETURNING s.channel, s.address, s.reason`,
        [projectId, EMAIL_CHANNELS, addresses.emails, PHONE_CHANNELS, addresses.phones, scopeIdentityIds],
      ),
    );

    for (const row of deleted) {
      await manager.query(
        `INSERT INTO erased_suppressions (project_id, channel, address_hash, reason)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id, channel, address_hash) DO NOTHING`,
        [projectId, row.channel, this.hashes.suppressionHash(projectId, row.channel, row.address), row.reason],
      );
    }
    return { kept: deleted.length, clearRowsDeleted: deleted.length };
  }

  /**
   * Turns hashes matching these addresses back into clear suppressions, and
   * returns how many it restored. Pass the caller's transaction so the locks
   * last until the address itself is stored; without one it runs its own.
   */
  async restore(
    projectId: string,
    address: { email?: string | null; phoneE164?: string | null },
    manager?: EntityManager,
  ): Promise<number> {
    const keys = this.keysFor(
      projectId,
      address.email ? [address.email] : [],
      address.phoneE164 ? [address.phoneE164] : [],
    );
    if (keys.length === 0) return 0;
    if (!manager) {
      return this.dataSource.transaction((own) => this.restore(projectId, address, own));
    }

    await this.lock(manager, projectId, keys);
    const found: Array<{ id: string; channel: MessageChannel; address_hash: string; reason: string }> =
      await manager.query(
        `SELECT id, channel, address_hash, reason FROM erased_suppressions
         WHERE project_id = $1 AND address_hash = ANY($2::varchar[])`,
        [projectId, keys.map((k) => k.hash)],
      );

    let restored = 0;
    for (const row of found) {
      const key = keys.find((k) => k.hash === row.address_hash && k.channel === row.channel);
      if (!key) continue;
      await manager.query(
        `INSERT INTO channel_suppressions (project_id, channel, address, reason, source, detail)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (project_id, channel, address) DO NOTHING`,
        [
          projectId,
          row.channel,
          key.address,
          row.reason,
          RESTORED_SUPPRESSION_SOURCE,
          'Suppressed before this person was erased; restored when the address was seen again.',
        ],
      );
      await manager.query('DELETE FROM erased_suppressions WHERE id = $1 AND project_id = $2', [
        row.id,
        projectId,
      ]);
      restored++;
    }
    return restored;
  }

  private keysFor(projectId: string, emails: string[], phones: string[]): AddressKey[] {
    const keys: AddressKey[] = [];
    const add = (channels: MessageChannel[], values: string[]) => {
      for (const address of values) {
        for (const channel of channels) {
          keys.push({ channel, address, hash: this.hashes.suppressionHash(projectId, channel, address) });
        }
      }
    };
    add(EMAIL_CHANNELS, emails);
    add(PHONE_CHANNELS, phones);
    return keys;
  }

  /** One transaction-scoped advisory lock per address key, always in the same order. */
  private async lock(manager: EntityManager, projectId: string, keys: AddressKey[]): Promise<void> {
    const ordered = [...new Set(keys.map((k) => k.hash))].sort();
    for (const hash of ordered) {
      await manager.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [
        `erased-suppression:${projectId}:${hash}`,
      ]);
    }
  }
}

/** `manager.query` returns `[rows, count]` for a DELETE or UPDATE under pg. */
export function affected(result: unknown): number {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  return Array.isArray(result) ? result.length : 0;
}

function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result) && result.length === 2 && Array.isArray(result[0]) && typeof result[1] === 'number') {
    return result[0] as T[];
  }
  return (result as T[]) ?? [];
}
