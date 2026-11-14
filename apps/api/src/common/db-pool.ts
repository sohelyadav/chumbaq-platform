/**
 * Connection limits for the customer API's database pool, so one tenant's slow
 * queries cannot hold every connection and stall every other tenant and every short
 * link. `pg` applies these per connection (`extra` is passed to its pool):
 *
 * - `max`: the pool size (pg's default is 10).
 * - `connectionTimeoutMillis`: a request waits at most this long for a free connection
 *   and then fails, instead of queueing without end.
 * - `statement_timeout`: no single statement runs longer.
 * - `lock_timeout`: no statement waits longer than this on a row or table lock.
 * - `idle_in_transaction_session_timeout`: a transaction left open is ended.
 *
 * Migrations never run on this pool (`run-migrations.ts`), so a long migration is
 * not cut off. The worker keeps its own, unbounded pool: its jobs are long by design.
 */
export const API_DB_POOL = {
  max: 20,
  connectionTimeoutMillis: 10_000,
  statement_timeout: 30_000,
  lock_timeout: 10_000,
  idle_in_transaction_session_timeout: 60_000,
} as const;
