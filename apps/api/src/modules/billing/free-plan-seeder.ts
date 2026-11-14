import { Injectable, OnModuleInit } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

/** The `free` row exactly as the plans migration seeds it: no limits of its own. */
export const FREE_PLAN_INSERT_SQL = `INSERT INTO "plans" ("code", "name", "mau_limit", "project_limit", "seat_limit", "sort_order", "is_active")
  VALUES ('free', 'Free', NULL, NULL, NULL, 0, true)
  ON CONFLICT ("code") DO NOTHING`;

/**
 * Where synchronize builds the schema (dev and test), no migration runs, so nothing
 * seeds the `free` plan; this adds it, so a dev database gives the same limits as a
 * migrated one. An existing row is left as it is. Elsewhere the migration seeds it
 * and this does nothing (the admin API and the worker never synchronize).
 */
@Injectable()
export class FreePlanSeeder implements OnModuleInit {
  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  async onModuleInit(): Promise<void> {
    if (!this.dataSource.options.synchronize) return;
    await this.dataSource.query(FREE_PLAN_INSERT_SQL);
  }
}
