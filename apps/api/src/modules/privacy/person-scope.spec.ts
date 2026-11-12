import { ConflictException } from '@nestjs/common';
import { resolvePersonScope, SIGNED_IN_DEVICE_MESSAGE } from './person-scope';

/**
 * A manager that answers like Postgres for the statements the resolver sends:
 * the anchor read, the locked read, and the shared-address read, in order.
 * Each scripted answer is what the database would hold at that moment.
 */
function managerAnswering(...answers: unknown[][]) {
  const sql: string[] = [];
  const query = jest.fn(async (statement: string) => {
    sql.push(statement);
    // The push-token lock answers nothing the resolver reads.
    if (/FROM push_tokens/.test(statement)) return [];
    return answers.shift() ?? [];
  });
  return { manager: { query } as never, sql };
}

const row = (id: string, external: string | null) => ({
  id,
  device_fingerprint: `fp-${id}`,
  external_user_id: external,
  email: null,
  phone_e164: null,
});
const PERSON = '11111111-1111-1111-1111-111111111111';

describe('resolvePersonScope', () => {
  it('locks the rows in one statement, in id order', async () => {
    const { manager, sql } = managerAnswering([row(PERSON, 'u1')], [row(PERSON, 'u1')]);
    await resolvePersonScope(manager, 'p', { type: 'personId', value: PERSON }, { lock: true });
    const locked = sql.find((s) => /FOR UPDATE/.test(s)) as string;
    expect(locked).toMatch(/ORDER BY id\s+LIMIT \d+ FOR UPDATE/);
    expect(sql.filter((s) => /FROM device_identities[\s\S]*FOR UPDATE/.test(s))).toHaveLength(1);
    expect(sql[0]).toContain('id = $2::uuid');
  });

  it('re-resolves a dashboard person whose external id changed before the lock', async () => {
    const { manager } = managerAnswering(
      [row(PERSON, 'u1')], // first anchor read
      [row(PERSON, 'u2')], // locked read: an identify changed it meanwhile
      [row(PERSON, 'u2')], // second attempt: anchor read
      [row(PERSON, 'u2'), row('22222222-2222-2222-2222-222222222222', 'u2')], // locked read
    );
    const keys = await resolvePersonScope(manager, 'p', { type: 'personId', value: PERSON }, { lock: true });
    expect(keys.externalUserIds).toEqual(['u2']);
    expect(keys.identityIds).toHaveLength(2);
  });

  it('refuses when it changes again, rather than acting on a stale id', async () => {
    const { manager } = managerAnswering(
      [row(PERSON, 'u1')], [row(PERSON, 'u2')],
      [row(PERSON, 'u2')], [row(PERSON, 'u3')],
    );
    await expect(
      resolvePersonScope(manager, 'p', { type: 'personId', value: PERSON }, { lock: true }),
    ).rejects.toThrow(ConflictException);
  });

  it('refuses rather than picks when more than one device matches a fingerprint', async () => {
    const { manager, sql } = managerAnswering([row(PERSON, null), row('22222222-2222-2222-2222-222222222222', null)]);
    await expect(
      resolvePersonScope(manager, 'p', { type: 'deviceFingerprint', value: 'fp' }, { lock: true }),
    ).rejects.toThrow('More than one device matches');
    expect(sql[0]).toMatch(/LIMIT 2$/);
    expect(sql).toHaveLength(1);
  });

  it('locks the devices\' push tokens, in token order, right after the devices', async () => {
    const { manager, sql } = managerAnswering([row(PERSON, 'u1')], [row(PERSON, 'u1')]);
    await resolvePersonScope(manager, 'p', { type: 'personId', value: PERSON }, { lock: true });
    const devices = sql.findIndex((s) => /FROM device_identities[\s\S]*FOR UPDATE/.test(s));
    const tokens = sql.findIndex((s) => /FROM push_tokens[\s\S]*ORDER BY token FOR UPDATE/.test(s));
    expect(tokens).toBe(devices + 1);
  });

  it('refuses a device that became signed in between the reads', async () => {
    const { manager } = managerAnswering([row(PERSON, null)], [row(PERSON, 'u9')]);
    await expect(
      resolvePersonScope(manager, 'p', { type: 'deviceFingerprint', value: 'fp' }, { lock: true }),
    ).rejects.toThrow(SIGNED_IN_DEVICE_MESSAGE);
  });
});
