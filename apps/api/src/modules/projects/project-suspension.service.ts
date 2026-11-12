import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ProjectEntity } from './entities/project.entity';

/**
 * Written to a campaign that was already queued or sending when its tenant was
 * suspended. Shown on the campaign page, including after reactivation.
 */
export const CAMPAIGN_STOPPED_BY_SUSPENSION =
  'Stopped because this account was suspended. Anyone not yet reached did not ' +
  'receive this campaign, and it will not resume automatically.';

/** Written to a scheduled campaign whose time came during a suspension. */
export const CAMPAIGN_MISSED_DURING_SUSPENSION =
  'Not sent: this account was suspended when the campaign was due. It will not ' +
  'be sent automatically; schedule it again if it is still wanted.';

/**
 * Whether a project's owner is suspended, for everything that acts on the
 * outside world without a logged-in user: redirects, campaign delivery,
 * schedulers, in-app delivery, outbound webhooks.
 *
 * Deliberately uncached, in every process. Suspension is often urgent, the
 * flag lives on `users`, and a cached "not suspended" would keep a link
 * resolving and a campaign sending after staff believed they had stopped it.
 * Callers therefore let a failed read propagate: an error here must never be
 * read as "not suspended".
 *
 * Registered through ProjectSuspensionModule rather than ProjectsModule, so the
 * worker, whose module tree is deliberately narrow, takes on no controller.
 */
@Injectable()
export class ProjectSuspensionService {
  constructor(
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
  ) {}

  async isSuspended(projectId: string): Promise<boolean> {
    const rows: unknown[] = await this.projectRepository.query(
      `SELECT 1
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       WHERE p.id = $1 AND u.suspended_at IS NOT NULL
       LIMIT 1`,
      [projectId],
    );
    return rows.length > 0;
  }

  /**
   * Every project belonging to a suspended tenant.
   *
   * The whole set rather than a lookup for given ids, because the schedulers
   * have to exclude these projects from a bounded read. Filtering after a
   * `LIMIT` would let one suspended tenant's backlog fill every page and starve
   * every other tenant. It is also empty nearly always, which lets a tick skip
   * its suspension work altogether.
   */
  async suspendedProjectIds(): Promise<Set<string>> {
    const rows: Array<{ id: string }> = await this.projectRepository.query(
      `SELECT p.id
       FROM projects p
       JOIN users u ON u.id = p.owner_id
       WHERE u.suspended_at IS NOT NULL`,
    );
    return new Set(rows.map((row) => row.id));
  }
}
