import { Check, Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * A plan an account can be on, and the limits it gives while billing is on.
 *
 * Plans are data: the code knows only `free`, which the migration seeds with no
 * limits of its own (so the environment defaults apply) and a trigger keeps from
 * being deleted or switched off. Staff create every other plan, its limits and
 * its prices. A null limit means unlimited, except a null project limit, which
 * means the `MAX_PROJECTS_PER_ACCOUNT` default (per-project caps bound an account
 * only through a finite project count).
 */
@Entity('plans')
@Check('CHK_plans_code', `"code" ~ '^[a-z][a-z0-9_]{1,31}$'`)
@Check('CHK_plans_mau_limit', `"mau_limit" >= 1`)
@Check('CHK_plans_project_limit', `"project_limit" BETWEEN 1 AND 1000`)
@Check('CHK_plans_seat_limit', `"seat_limit" >= 1`)
export class PlanEntity {
  @PrimaryColumn({ type: 'varchar', length: 32, primaryKeyConstraintName: 'PK_plans' })
  code: string;

  @Column({ type: 'varchar', length: 60 })
  name: string;

  @Column({ type: 'int', name: 'mau_limit', nullable: true })
  mauLimit: number | null;

  @Column({ type: 'int', name: 'project_limit', nullable: true })
  projectLimit: number | null;

  @Column({ type: 'int', name: 'seat_limit', nullable: true })
  seatLimit: number | null;

  /** Order on the pricing list, and the rank that tells an upgrade from a downgrade. */
  @Column({ type: 'int', name: 'sort_order', default: 0 })
  sortOrder: number;

  @Column({ type: 'boolean', name: 'is_active', default: true })
  isActive: boolean;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt: Date;
}
