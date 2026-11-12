import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { DataSource } from 'typeorm';
import type { TripwireView } from '@chumbaq/shared';
import { normaliseEmail } from '../users/email';
import { SecurityAlertsService } from './security-alerts.service';

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export type TrippedAction = 'sign_in' | 'sign_up' | 'password_reset' | 'invite';

interface TripwireRow {
  id: string;
  kind: 'api_key' | 'account';
  label: string;
  created_at: Date;
  revoked_at: Date | null;
}

/**
 * Trap data. Checks run only where a request has already failed or names an address no
 * account has (an unknown API key, an unknown email), so a real request never pays for
 * them, and the `...Later` forms are not awaited, so the answer is the same, and as
 * quick, as for any other unknown key or address.
 */
@Injectable()
export class TripwiresService {
  private readonly logger = new Logger(TripwiresService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly alerts: SecurityAlertsService,
  ) {}

  /** A key shaped like a real project key (`chumbaq_` and 64 hex), shown once. */
  async createApiKey(label: string, staffId: string): Promise<{ id: string; key: string }> {
    const key = `chumbaq_${randomBytes(32).toString('hex')}`;
    const id = await this.insert('api_key', sha256(key), label, staffId);
    return { id, key };
  }

  async createAccount(email: string, label: string, staffId: string): Promise<{ id: string }> {
    const address = normaliseEmail(email);
    const [user] = await this.dataSource.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [address]);
    if (user) throw new ConflictException('That address belongs to an account; a trap must be an address nobody uses');
    return {
      id: await this.insert('account', sha256(address), label, staffId),
    };
  }

  private async insert(kind: TripwireRow['kind'], hash: string, label: string, staffId: string): Promise<string> {
    const [row] = await this.dataSource.query(
      `INSERT INTO security_tripwires (kind, value_hash, label, created_by) VALUES ($1, $2, $3, $4)
       ON CONFLICT (value_hash) DO NOTHING RETURNING id`,
      [kind, hash, label, staffId],
    );
    if (!row) throw new ConflictException('That trap already exists');
    return row.id;
  }

  async list(): Promise<TripwireView[]> {
    const rows: TripwireRow[] = await this.dataSource.query(
      `SELECT id, kind, label, created_at, revoked_at FROM security_tripwires ORDER BY created_at DESC`,
    );
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      label: r.label,
      createdAt: r.created_at.toISOString(),
      revokedAt: r.revoked_at ? r.revoked_at.toISOString() : null,
    }));
  }

  /** Returns the trap's label, for the audit entry. */
  async revoke(id: string): Promise<{ label: string; kind: TripwireRow['kind'] }> {
    const [rows] = await this.dataSource.query(
      `UPDATE security_tripwires SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL RETURNING label, kind`,
      [id],
    );
    const row = (rows as { label: string; kind: TripwireRow['kind'] }[])[0];
    if (!row) throw new NotFoundException('No active trap with that id');
    return row;
  }

  /** Is this unknown address a trap? Awaited only where the answer must change (sign-up). */
  async findAccount(email: string): Promise<{ id: string; label: string } | null> {
    const [row] = await this.dataSource.query(
      `SELECT id, label FROM security_tripwires WHERE kind = 'account' AND value_hash = $1 AND revoked_at IS NULL`,
      [sha256(normaliseEmail(email))],
    );
    return row ?? null;
  }

  async trippedAccount(trap: { id: string; label: string }, action: TrippedAction, ip: string | null): Promise<void> {
    // One alarm per trap and kind of touch, so a reset after a sign-in is its own email.
    await this.alerts.raise('tripwire.account', `${trap.id}:${action}`, { label: trap.label, action }, ip);
  }

  checkEmailLater(email: string, action: TrippedAction, ip: string | null): void {
    this.findAccount(email)
      .then((trap) => (trap ? this.trippedAccount(trap, action, ip) : undefined))
      .catch((error: Error) => this.logger.error(`Trap account check failed: ${error.message}`));
  }

  checkApiKeyLater(rawKey: string, context: { ip: string | null; route: string }): void {
    if (typeof rawKey !== 'string' || rawKey.length > 200) return;
    this.dataSource
      .query(
        `SELECT id, label FROM security_tripwires WHERE kind = 'api_key' AND value_hash = $1 AND revoked_at IS NULL`,
        [sha256(rawKey)],
      )
      .then(async ([trap]: { id: string; label: string }[]) => {
        if (trap)
          await this.alerts.raise('tripwire.api_key', trap.id, { label: trap.label, route: context.route }, context.ip);
      })
      .catch((error: Error) => this.logger.error(`Trap key check failed: ${error.message}`));
  }
}
