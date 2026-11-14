import { DataSource } from 'typeorm';
import { API_DB_POOL } from './db-pool';

/** The limits reach every connection of the API's pool, as Postgres settings. */
describe('API database pool (integration)', () => {
  let ds: DataSource;

  beforeAll(async () => {
    ds = new DataSource({
      type: 'postgres',
      host: process.env.DATABASE_HOST,
      port: Number(process.env.DATABASE_PORT),
      username: process.env.DATABASE_USER,
      password: process.env.DATABASE_PASSWORD,
      database: `${process.env.DATABASE_NAME}_int`,
      extra: API_DB_POOL,
    });
    await ds.initialize();
  });

  afterAll(() => ds.destroy());

  it('sets the statement, lock and idle-transaction timeouts on each connection', async () => {
    const [row] = await ds.query(
      `SELECT current_setting('statement_timeout') AS statement,
              current_setting('lock_timeout') AS lock,
              current_setting('idle_in_transaction_session_timeout') AS idle`,
    );
    expect(row).toEqual({ statement: '30s', lock: '10s', idle: '1min' });
  });

});
