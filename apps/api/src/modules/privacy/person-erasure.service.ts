import { Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { PersonErasureResult, PrivacySubject } from '@chumbaq/shared';
import { ErasedSuppressionsService, affected } from './erased-suppressions.service';
import { PERSON_INVENTORY, eraseStatement } from './person-inventory';
import { NOT_ERASED, isEmptyScope, resolvePersonScope } from './person-scope';
import { PrivacyRequestsService } from './privacy-requests.service';
import { activityActorOf, personTarget, type PrivacyActor } from './privacy-actor';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import type { ActivityContext } from '../project-activity/activity-context';

/**
 * Erases everything a project holds about one person (DPDP s.8(7)).
 *
 * One transaction: the person's rows are locked, their suppressions become
 * keyed hashes, every inventory table is cleared in order, and the request is
 * logged (in `privacy_request_logs`, and as `person.erased` in the project
 * activity log), all committing together or not at all. Nothing is
 * batched: a very large history makes a longer transaction, never half an
 * erasure, and a failed call can simply be repeated.
 *
 * Idempotent: a second call finds nothing and answers `nothing_to_erase`
 * (also logged), never an error.
 *
 * Every statement is constrained to `projectId`, which callers take from the
 * authenticated project (the dashboard's ownership check, or the API key's
 * own project), never from the request body.
 */
/** Tries in all, for a transaction ended by a deadlock or a serialization failure. */
export const ERASE_ATTEMPTS = 3;

/** 50 to 200 ms. */
export function retryDelayMs(random: () => number = Math.random): number {
  return 50 + Math.floor(random() * 151);
}

/** Postgres deadlock_detected and serialization_failure. */
export function isRetryable(error: unknown): boolean {
  const e = error as { code?: unknown; driverError?: { code?: unknown } } | null;
  const code = e?.code ?? e?.driverError?.code;
  return code === '40P01' || code === '40001';
}

@Injectable()
export class PersonErasureService {
  private readonly logger = new Logger(PersonErasureService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly suppressions: ErasedSuppressionsService,
    private readonly requests: PrivacyRequestsService,
    private readonly activity: ProjectActivityService,
  ) {}

  async erase(
    projectId: string,
    subject: PrivacySubject,
    actor: PrivacyActor,
    ctx: ActivityContext,
  ): Promise<PersonErasureResult> {
    // A deadlock or serialization failure rolls the whole transaction back,
    // so trying again cannot leave anything half done.
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.eraseOnce(projectId, subject, actor, ctx);
      } catch (error) {
        if (attempt >= ERASE_ATTEMPTS || !isRetryable(error)) throw error;
        this.logger.warn(`Privacy erasure in project ${projectId} retried after ${(error as { code?: string }).code}`);
        // Jittered, so two erasures that deadlocked each other do not meet again.
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs()));
      }
    }
  }

  private eraseOnce(
    projectId: string,
    subject: PrivacySubject,
    actor: PrivacyActor,
    ctx: ActivityContext,
  ): Promise<PersonErasureResult> {
    return this.dataSource.transaction(async (manager) => {
      const keys = await resolvePersonScope(manager, projectId, subject, { lock: true });
      const counts: Record<string, number> = {};
      let suppressionsKept = 0;

      if (!isEmptyScope(keys)) {
        const suppressed = await this.suppressions.hashPersonSuppressions(
          manager,
          projectId,
          keys.identityIds,
          { emails: keys.emails, phones: keys.phones },
        );
        suppressionsKept = suppressed.kept;
        counts.channel_suppressions = suppressed.clearRowsDeleted;

        for (const entry of PERSON_INVENTORY) {
          const statement = eraseStatement(entry, keys);
          if (!statement) continue;
          counts[entry.name] = affected(await manager.query(statement.sql, statement.params));
        }
      }

      const total = Object.values(counts).reduce((sum, n) => sum + n, 0) + suppressionsKept;
      const result = total > 0 ? 'erased' : 'nothing_to_erase';
      // The log (the fiduciary's record, seen only by the project owner) keeps
      // every count. The response leaves out suppressions: how many clear
      // rows went and how many were kept as hashes would tell a caller holding
      // a claimed address whether that address had ever opted out.
      const requestId = await this.requests.record(manager, {
        projectId,
        kind: 'erasure',
        subject,
        keys,
        actor,
        result,
        counts: { ...counts, erased_suppressions_kept: suppressionsKept },
      });

      // In this attempt's transaction, like the request log above: a retried
      // attempt's entry rolled back with it, and a failed erasure leaves none.
      // Written whenever the request is (`nothing_to_erase` too), naming the
      // person by internal id only.
      await this.activity.record(
        {
          projectId,
          actor: activityActorOf(actor),
          action: 'person.erased',
          target: personTarget(subject, keys),
        },
        ctx,
        manager,
      );

      // Ids and counts only: the person's identifiers never reach a log line.
      this.logger.log(
        `Privacy erasure ${requestId} in project ${projectId} by ${actor.type}: ${result}, ${total} rows`,
      );
      const { channel_suppressions: _suppressions, ...shown } = counts;
      return { result, requestId, counts: shown, notErased: NOT_ERASED };
    });
  }
}
