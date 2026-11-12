import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import type { PersonExport, PersonExportSection, PrivacySubject } from '@chumbaq/shared';
import { PERSON_INVENTORY, exportStatements } from './person-inventory';
import { PersonKeys, isEmptyScope, resolvePersonScope } from './person-scope';
import { PrivacyRequestsService } from './privacy-requests.service';
import { activityActorOf, personTarget, type PrivacyActor } from './privacy-actor';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import type { ActivityContext } from '../project-activity/activity-context';

/**
 * At most this many rows per table, newest first. A person with more gets the
 * newest ones and `truncated: true` on that section and on the whole export,
 * so the document is bounded however long their history is.
 */
export const EXPORT_ROW_CAP_PER_SECTION = 5000;

/** Stands in for any SDK-set id the export cannot show (see `withholdLinks`). */
export const WITHHELD_IDENTIFIER = '[withheld]';

/** Exported columns holding an id the SDK set. */
const LINK_COLUMNS = ['distinctId', 'anonymousId'];

export const NOT_INCLUDED = [
  'Rows recorded under an id that was never linked to this person (anonymous ids before sign-in, earlier ids)',
  'Email, SMS and WhatsApp delivery and opt-out history, because an address can pass between people; contact Chumbaq support if you need it',
  'Mixpanel cohort memberships that Mixpanel did not match to this user id',
  'The last-activity time on each device',
];

/**
 * Everything a project holds about one person, as one JSON document: the same
 * inventory erasure walks, with allow-listed columns only (no push token
 * values, no internal diagnostics, nothing from settings or credentials).
 *
 * Read in one REPEATABLE READ, read-only transaction so every section comes
 * from the same moment. Logged as an `export` privacy request, and as
 * `person.exported` in the project activity log before the document is
 * returned, both in one transaction: a log write that fails fails the export
 * and leaves neither record, so nobody walks away with a person's data
 * unrecorded and no export is recorded that never happened.
 */
@Injectable()
export class PersonExportService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly requests: PrivacyRequestsService,
    private readonly activity: ProjectActivityService,
  ) {}

  async export(
    projectId: string,
    subject: PrivacySubject,
    actor: PrivacyActor,
    ctx: ActivityContext,
  ): Promise<PersonExport> {
    const { keys, sections } = await this.dataSource.transaction(
      'REPEATABLE READ',
      async (manager) => {
        await manager.query('SET TRANSACTION READ ONLY');
        const keys = await resolvePersonScope(manager, projectId, subject, { lock: false });
        const sections: Record<string, PersonExportSection> = {};
        const rowsBySection: Record<string, unknown>[][] = [];
        for (const entry of PERSON_INVENTORY) {
          const statements = exportStatements(entry, keys, EXPORT_ROW_CAP_PER_SECTION);
          if (!statements) continue;
          if (isEmptyScope(keys)) {
            sections[entry.name] = { total: 0, truncated: false, rows: [] };
            continue;
          }
          const [{ total }] = await manager.query(statements.count.sql, statements.count.params);
          const rows: Record<string, unknown>[] =
            total > 0 ? await manager.query(statements.rows.sql, statements.rows.params) : [];
          rowsBySection.push(rows);
          sections[entry.name] = { total, truncated: total > rows.length, rows };
        }
        withholdLinks(keys, rowsBySection.flat());
        return { keys, sections };
      },
    );

    const counts = Object.fromEntries(
      Object.entries(sections).map(([name, section]) => [name, section.total]),
    );
    const found = Object.values(counts).some((n) => n > 0);
    // Both records in one short transaction: a failed activity write leaves no
    // `exported` request behind, and the reverse. The entry is written whenever
    // the request is (`nothing_found` too), by internal id only.
    await this.dataSource.transaction(async (manager) => {
      await this.requests.record(manager, {
        projectId,
        kind: 'export',
        subject,
        keys: keys as PersonKeys,
        actor,
        result: found ? 'exported' : 'nothing_found',
        counts,
      });
      await this.activity.record(
        {
          projectId,
          actor: activityActorOf(actor),
          action: 'person.exported',
          target: personTarget(subject, keys),
        },
        ctx,
        manager,
      );
    });

    return {
      exportedAt: new Date().toISOString(),
      projectId,
      subject,
      rowCapPerSection: EXPORT_ROW_CAP_PER_SECTION,
      truncated: Object.values(sections).some((section) => section.truncated),
      notIncluded: NOT_INCLUDED,
      sections,
    };
  }
}

/**
 * An SDK-set id (a device's `distinct_id`, an alias's anonymous id) is shown
 * only when it is the verified external id or one of the person's own
 * devices' fingerprints; anything else is always `[withheld]`. Always, not
 * only when someone else holds it: withholding conditionally would tell the
 * reader whether an id exists elsewhere in the project.
 */
function withholdLinks(keys: PersonKeys, rows: Record<string, unknown>[]): void {
  const shown = new Set([...keys.externalUserIds, ...keys.fingerprints]);
  for (const row of rows) {
    for (const column of LINK_COLUMNS) {
      const value = row[column];
      if (typeof value === 'string' && !shown.has(value)) row[column] = WITHHELD_IDENTIFIER;
    }
  }
}
