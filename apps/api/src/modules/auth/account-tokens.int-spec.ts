import { DataSource } from 'typeorm';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { AccountTokensService } from './account-tokens.service';
import { AccountTokenEntity } from './entities/account-token.entity';

const USER_ID = '7a3c0f52-5b1e-4d8a-9c61-0e4f3b2a1d01';
const OTHER_ID = '7a3c0f52-5b1e-4d8a-9c61-0e4f3b2a1d02';

describe('AccountTokensService.spendStaffLink (integration)', () => {
  let ds: DataSource;
  let tokens: AccountTokensService;

  const cleanup = async () => {
    await ds.query(`DELETE FROM account_tokens WHERE user_id = ANY($1::uuid[])`, [[USER_ID, OTHER_ID]]);
    await ds.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [[USER_ID, OTHER_ID]]);
  };

  beforeAll(async () => {
    ds = await openIntDb();
    tokens = new AccountTokensService(ds.getRepository(AccountTokenEntity));
  });

  afterAll(async () => {
    await cleanup();
    await closeIntDb(ds);
  });

  beforeEach(async () => {
    await cleanup();
    await ds.query(
      `INSERT INTO users (id, email, password_hash, name) VALUES
         ($1, 'spend-staff-link@test.local', 'x', 'a'), ($2, 'spend-staff-link-2@test.local', 'x', 'b')`,
      [USER_ID, OTHER_ID],
    );
  });

  it('is true once, then false for a link already spent', async () => {
    const link = await tokens.issueByStaff(USER_ID, ds.manager, 0, 60_000);

    await expect(tokens.spendStaffLink(USER_ID, link.id, ds.manager)).resolves.toBe(true);
    await expect(tokens.spendStaffLink(USER_ID, link.id, ds.manager)).resolves.toBe(false);
  });

  it("is false, and spends nothing, for another user's link", async () => {
    const link = await tokens.issueByStaff(OTHER_ID, ds.manager, 0, 60_000);

    await expect(tokens.spendStaffLink(USER_ID, link.id, ds.manager)).resolves.toBe(false);
    const [row] = await ds.query(`SELECT used_at FROM account_tokens WHERE id = $1`, [link.id]);
    expect(row.used_at).toBeNull();
  });

  it('is false for a link that does not exist', async () => {
    await expect(
      tokens.spendStaffLink(USER_ID, '00000000-0000-4000-8000-000000000000', ds.manager),
    ).resolves.toBe(false);
  });
});
