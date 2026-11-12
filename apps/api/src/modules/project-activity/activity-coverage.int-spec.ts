import type { ProjectActivityAction } from '@chumbaq/shared';
import { INestApplication } from '@nestjs/common';
import { ACTIVITY_COVERAGE } from '../../test-support/activity-coverage';
import { closeIntDb, openIntDb } from '../../test-support/int-db';
import { Route, bootDashboardApp, enumerateRoutes } from '../../test-support/sweep-fixtures';
import { ACTIVITY_ACTION_GROUPS } from './activity-groups';

/**
 * Fail-closed coverage of the project activity log: every dashboard write route
 * (non-GET with `@RequireProjectPermission`), plus the person-export GET, must either
 * name the actions it logs or be listed in `test-support/activity-coverage.ts` as not
 * logged, with a reason. A new route that is in neither fails here, so it cannot ship
 * unlogged by accident. The routes are read from the running app, not listed here.
 */
describe('project activity coverage (int)', () => {
  let app: INestApplication;
  let restoreEnv: () => void;
  let ds: Awaited<ReturnType<typeof openIntDb>>;
  let routes: Route[];

  // The two GETs that are consequential: handing out a person's data, and the activity CSV.
  const LOGGED_GETS = new Set([
    'GET /api/projects/:projectId/users/:personId/export',
    'GET /api/projects/:projectId/activity/export',
  ]);
  const inScope = (r: Route) => (r.method !== 'GET' && !!r.permission) || LOGGED_GETS.has(r.key);

  beforeAll(async () => {
    ds = await openIntDb();
    ({ app, restoreEnv } = await bootDashboardApp());
    routes = enumerateRoutes(app);
  });

  afterAll(async () => {
    await app?.close();
    await closeIntDb(ds);
    restoreEnv();
  });

  it('every write route (and the person export) is mapped', () => {
    const missing = routes.filter(inScope).map((r) => r.key).filter((k) => !(k in ACTIVITY_COVERAGE));
    expect(missing).toEqual([]);
  });

  it('every mapped key is a live route (no stale entries)', () => {
    const live = new Set(routes.filter(inScope).map((r) => r.key));
    const stale = Object.keys(ACTIVITY_COVERAGE).filter((k) => !live.has(k));
    expect(stale).toEqual([]);
  });

  it('every notLogged entry has a reason', () => {
    const bad = Object.entries(ACTIVITY_COVERAGE)
      .filter(([, v]) => 'notLogged' in v && v.notLogged.trim().length < 5)
      .map(([k]) => k);
    expect(bad).toEqual([]);
  });

  it('every action is logged by some mapped route', () => {
    const logged = new Set<string>();
    for (const v of Object.values(ACTIVITY_COVERAGE)) if ('logs' in v) v.logs.forEach((a) => logged.add(a));
    // Not logged by a route the sweep can see:
    //  - staff.viewed_as: written by the impersonation exchange; covered by
    //    impersonation-handoffs.int-spec.ts.
    //  - invite.accepted: written by POST /api/invitations/accept, which is by invite token and
    //    carries no @RequireProjectPermission; covered by team-activity.int-spec.ts.
    // (The server-API-key routes under /api/privacy log person.erased and person.exported, which
    // dashboard routes log too, so they need no exemption; privacy-activity.int-spec.ts covers them.)
    const EXEMPT = new Set<string>(['staff.viewed_as', 'invite.accepted']);
    const unlogged = (Object.keys(ACTIVITY_ACTION_GROUPS) as ProjectActivityAction[]).filter(
      (a) => !logged.has(a) && !EXEMPT.has(a),
    );
    expect(unlogged).toEqual([]);
  });
});
