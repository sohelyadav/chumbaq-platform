import { createHash, randomBytes } from 'crypto';

/**
 * `admin:staff-enrolment` codes. Plain functions over a query runner, because the CLI,
 * staff sign-in, staff factor enrolment and the customer password reset all need them,
 * each inside its own transaction.
 */

type Queryable = { query: (sql: string, params?: unknown[]) => Promise<unknown> };

/** How long an operator's enrolment code works. */
export const STAFF_ENROLMENT_ALLOWANCE_HOURS = 24;

export type AllowanceVoidReason = 'replaced' | 'enrolled' | 'password_reset';

export const hashEnrolmentCode = (code: string) => createHash('sha256').update(code).digest('hex');

/**
 * A new code, replacing any unspent one, so only the code the operator last handed over
 * works. 32 random bytes, base64url: 256 bits, far past guessing within the sign-in
 * limit. The code itself is returned once and never stored.
 */
export async function issueStaffEnrolmentAllowance(
  manager: Queryable,
  userId: string,
): Promise<{ id: string; code: string; expiresAt: Date }> {
  await voidStaffEnrolmentAllowances(manager, userId, 'replaced');
  const code = randomBytes(32).toString('base64url');
  const [row] = (await manager.query(
    `INSERT INTO staff_enrolment_allowances (user_id, code_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(hours => $3))
     RETURNING id, expires_at`,
    [userId, hashEnrolmentCode(code), STAFF_ENROLMENT_ALLOWANCE_HOURS],
  )) as { id: string; expires_at: Date }[];
  return { id: row.id, code, expiresAt: new Date(row.expires_at) };
}

/**
 * Spends the person's code if it is theirs, unexpired, unspent and not voided. One
 * conditional UPDATE, so of two sign-ins with the same code exactly one gets it. Returns
 * the allowance id, or null.
 */
export async function spendStaffEnrolmentAllowance(
  manager: Queryable,
  userId: string,
  code: string,
  ipAddress: string | null,
): Promise<string | null> {
  // TypeORM answers an UPDATE's raw query with [rows, rowCount].
  const [rows] = (await manager.query(
    `UPDATE staff_enrolment_allowances SET used_at = now(), used_ip = $3
      WHERE user_id = $1 AND code_hash = $2
        AND used_at IS NULL AND voided_at IS NULL AND expires_at > now()
      RETURNING id`,
    [userId, hashEnrolmentCode(code), ipAddress?.slice(0, 64) ?? null],
  )) as [{ id: string }[], number];
  return rows?.[0]?.id ?? null;
}

/** Every unspent code of the person stops working. */
export async function voidStaffEnrolmentAllowances(
  manager: Queryable,
  userId: string,
  reason: AllowanceVoidReason,
): Promise<void> {
  await manager.query(
    `UPDATE staff_enrolment_allowances SET voided_at = now(), voided_reason = $2
      WHERE user_id = $1 AND used_at IS NULL AND voided_at IS NULL`,
    [userId, reason],
  );
}
