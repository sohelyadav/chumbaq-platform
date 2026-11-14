import { Injectable, Logger } from '@nestjs/common';
import type { UsageCoverage as SharedUsageCoverage } from '@chumbaq/shared';
import { DataSource, EntityManager, QueryRunner } from 'typeorm';
import { addDays, dayStart, monthStart, utcDay } from './usage-days';
import {
  ProjectOwner,
  countWindow,
  pruneActiveDevices,
  recordActiveDevices,
  writeApiKeySnapshot,
  writeMauSnapshot,
} from './usage-counting';

/** Projects per transaction. */
export const USAGE_PROJECT_BATCH = 200;
/** Days counted before the first run, from the raw rows still there. */
export const USAGE_BACKFILL_DAYS = 90;
/** Days closed per tick at most, so a long catch-up spreads over several hours. */
export const USAGE_MAX_DAYS_PER_TICK = 31;
/** Pause between transactions, so the roll-up never holds the database for long. */
export const USAGE_BATCH_PAUSE_MS = 100;
/** The session advisory lock key: one roll-up per database at a time. */
export const USAGE_LOCK_SQL = `hashtext('usage_rollup')`;
/**
 * Today's active devices are recorded from a little before the last run, so a
 * row committed late in the previous hour is still caught. Closing the day
 * rescans it whole anyway.
 */
const DEVICE_OVERLAP_MS = 10 * 60 * 1000;

export type RollupTick = { status: 'skipped' } | { status: 'ran'; closedDays: string[]; todayProjects: number };

/**
 * What the usage tables cover, as UTC days:
 * - `startedOn`: the first run.
 * - `countedFrom`: the first day counted (the backfill's start).
 * - `countedThrough`: the last closed day; null until one is closed. Nothing
 *   after it is shown.
 * - `mauFrom`: the first day of the month active devices are counted from.
 *
 * Active API keys have no range here: they are snapshotted only when the day
 * closed is yesterday, and stored for every project then, zeros included, so
 * a day without an `api_keys_active` row was not snapshotted (unknown).
 */
export interface UsageCoverage {
  startedOn: string;
  countedFrom: string;
  countedThrough: string | null;
  mauFrom: string;
}

// The admin API returns this as the shared type; held equal both ways.
type _SameCoverage = [UsageCoverage] extends [SharedUsageCoverage]
  ? [SharedUsageCoverage] extends [UsageCoverage]
    ? true
    : never
  : never;
const _usageCoverageMatches: _SameCoverage = true;
void _usageCoverageMatches;

interface RollupState {
  startedOn: string;
  firstDay: string;
  lastClosedDay: string;
  devicesThrough: Date | null;
}

const STATE_SQL = `
  SELECT to_char(started_on, 'YYYY-MM-DD') AS "startedOn",
         to_char(first_day, 'YYYY-MM-DD') AS "firstDay",
         to_char(last_closed_day, 'YYYY-MM-DD') AS "lastClosedDay",
         devices_through AS "devicesThrough"
    FROM usage_rollup_state WHERE id = 1`;

/**
 * Rolls usage up into `usage_daily`, run hourly by the worker.
 *
 * Each tick, holding a session advisory lock (a second worker on the same
 * database skips rather than waits):
 * 1. closes every finished UTC day after the last closed one, oldest first,
 *    at most `USAGE_MAX_DAYS_PER_TICK`: a final count, after which the day is
 *    never written again (an erasure or delete later never lowers it);
 * 2. counts today so far, and records today's active devices, so activity
 *    erased or deleted later in the day has mostly been counted already;
 * 3. prunes active-device months past keeping.
 *
 * The first run starts the state ninety days back, so those days are counted
 * from the raw rows that remain. Active devices (and their monthly count) only
 * from the first day of the first run's month, and active API keys only on the
 * day closed the night after, since neither can be rebuilt for the past.
 *
 * Projects go in batches by id, one transaction per batch and day, with a
 * short pause between. Each row carries the project's billing owner when it is
 * written. Logs one line per closed day and nothing per project.
 */
@Injectable()
export class UsageRollupService {
  private readonly logger = new Logger(UsageRollupService.name);

  /** Between transactions; tests set it to 0. */
  pauseMs = USAGE_BATCH_PAUSE_MS;

  constructor(private readonly dataSource: DataSource) {}

  async runTick(now: Date = new Date()): Promise<RollupTick> {
    const runner = this.dataSource.createQueryRunner();
    await runner.connect();
    try {
      const [{ locked }] = await runner.query(`SELECT pg_try_advisory_lock(${USAGE_LOCK_SQL}) AS locked`);
      if (!locked) return { status: 'skipped' };
      try {
        return await this.run(runner, now);
      } finally {
        await runner.query(`SELECT pg_advisory_unlock(${USAGE_LOCK_SQL})`);
      }
    } finally {
      await runner.release();
    }
  }

  /** What the tables cover, or null before the first run. */
  async readCoverage(manager: EntityManager): Promise<UsageCoverage | null> {
    const [state]: RollupState[] = await manager.query(STATE_SQL);
    if (!state) return null;
    return {
      startedOn: state.startedOn,
      countedFrom: state.firstDay,
      countedThrough: state.lastClosedDay >= state.firstDay ? state.lastClosedDay : null,
      mauFrom: monthStart(state.startedOn),
    };
  }

  private async run(runner: QueryRunner, now: Date): Promise<RollupTick> {
    const today = utcDay(now);
    const yesterday = addDays(today, -1);
    const firstDay = addDays(today, -USAGE_BACKFILL_DAYS);
    await runner.query(
      `INSERT INTO usage_rollup_state (id, started_on, first_day, last_closed_day)
       VALUES (1, $1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [today, firstDay, addDays(firstDay, -1)],
    );
    let state = await this.readState(runner);
    const mauFrom = monthStart(state.startedOn);

    const closedDays: string[] = [];
    for (let day = addDays(state.lastClosedDay, 1); day <= yesterday; day = addDays(day, 1)) {
      if (closedDays.length >= USAGE_MAX_DAYS_PER_TICK) break;
      await this.closeDay(runner, state, day, { mauFrom, keys: day === yesterday ? now : null });
      closedDays.push(day);
      state = await this.readState(runner);
    }

    let todayProjects = 0;
    if (today > state.lastClosedDay) {
      const deviceFrom = new Date(
        Math.max(dayStart(today).getTime(), (state.devicesThrough?.getTime() ?? 0) - DEVICE_OVERLAP_MS),
      );
      todayProjects = await this.eachBatch(runner, async (m, batch) => {
        this.assertOpen(state, today);
        await countWindow(m, batch, today, dayStart(today), now);
        await recordActiveDevices(m, batch.map((p) => p.id), deviceFrom, now);
      });
      await runner.query(`UPDATE usage_rollup_state SET devices_through = $1, updated_at = now() WHERE id = 1`, [now]);
    }

    await pruneActiveDevices(runner.manager, today);
    return { status: 'ran', closedDays, todayProjects };
  }

  /** The final count of `day`, then the state moves past it. */
  private async closeDay(
    runner: QueryRunner,
    state: RollupState,
    day: string,
    options: { mauFrom: string; keys: Date | null },
  ): Promise<void> {
    this.assertOpen(state, day);
    const started = Date.now();
    const from = dayStart(day);
    const to = dayStart(addDays(day, 1));
    const projects = await this.eachBatch(runner, async (m, batch) => {
      await countWindow(m, batch, day, from, to);
      if (day >= options.mauFrom) {
        await recordActiveDevices(m, batch.map((p) => p.id), from, to);
        await writeMauSnapshot(m, batch, day);
      }
      if (options.keys) await writeApiKeySnapshot(m, batch, day, options.keys);
    });
    const [, moved] = await runner.query(
      `UPDATE usage_rollup_state SET last_closed_day = $1::date, updated_at = now()
        WHERE id = 1 AND last_closed_day = $1::date - 1`,
      [day],
    );
    if (moved !== 1) throw new Error(`Usage state moved while closing ${day}`);
    this.logger.log(`Usage closed ${day}: ${projects} projects in ${Date.now() - started} ms`);
  }

  /** Never write a closed day. */
  private assertOpen(state: RollupState, day: string): void {
    if (day <= state.lastClosedDay) {
      throw new Error(`Usage for ${day} is closed (through ${state.lastClosedDay})`);
    }
  }

  /**
   * Runs `work` over every project in batches by id, one transaction each,
   * with the billing owner read in that transaction. Returns the projects seen.
   */
  private async eachBatch(
    runner: QueryRunner,
    work: (manager: EntityManager, batch: ProjectOwner[]) => Promise<void>,
  ): Promise<number> {
    let cursor: string | null = null;
    let seen = 0;
    for (;;) {
      await runner.startTransaction();
      let batch: ProjectOwner[];
      try {
        batch = await runner.query(
          `SELECT id, owner_id AS "ownerId" FROM projects
            WHERE ($1::uuid IS NULL OR id > $1::uuid) ORDER BY id LIMIT $2`,
          [cursor, USAGE_PROJECT_BATCH],
        );
        if (batch.length > 0) await work(runner.manager, batch);
        await runner.commitTransaction();
      } catch (error) {
        await runner.rollbackTransaction();
        throw error;
      }
      seen += batch.length;
      if (batch.length < USAGE_PROJECT_BATCH) return seen;
      cursor = batch[batch.length - 1].id;
      if (this.pauseMs > 0) await new Promise((resolve) => setTimeout(resolve, this.pauseMs));
    }
  }

  private async readState(runner: QueryRunner): Promise<RollupState> {
    const [state]: RollupState[] = await runner.query(STATE_SQL);
    return state;
  }
}
