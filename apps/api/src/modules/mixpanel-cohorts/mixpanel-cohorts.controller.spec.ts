import 'reflect-metadata';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { MixpanelCohortsController } from './mixpanel-cohorts.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';
const USERNAME = 'chumbaq-sync.4f1e2d.mp-service-account';

const access = (role: ProjectRole, impersonated = false): ProjectAccess => ({
  project: { id: PROJECT } as never,
  role,
  isBillingOwner: role === 'owner',
  impersonated,
  can: (p) => roleCan(role, p),
});

const handlersOf = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor').sort();

const declared = (controller: { prototype: object }, handler: string) =>
  Reflect.getMetadata(
    PROJECT_PERMISSION_KEY,
    (controller.prototype as Record<string, unknown>)[handler] as object,
  );

describe('MixpanelCohortsController route permissions', () => {
  const param = { param: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['configure', 'channels.manage', param],
    ['getStatus', 'project.read', param],
    // Members import cohorts, which needs the list to pick from.
    ['listAvailableCohorts', 'project.read', param],
    ['importCohort', 'messaging.write', param],
    ['listCohorts', 'project.read', param],
    ['getCohort', 'project.read', param],
    ['syncCohort', 'messaging.write', param],
    ['listMembers', 'project.read', param],
    ['getPushStats', 'project.read', param],
    ['sendPush', 'messaging.write', param],
    ['getIamStats', 'project.read', param],
    ['triggerIamForCohort', 'messaging.write', param],
    ['deleteCohort', 'messaging.write', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(MixpanelCohortsController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(MixpanelCohortsController)).toEqual(table.map(([h]) => h).sort());
  });
});

describe('MixpanelCohortsController status', () => {
  const status = () => ({
    configured: true,
    isActive: true,
    lastTestAt: new Date('2026-11-01T10:00:00Z'),
    mixpanelProjectId: '3141592',
    serviceAccountUsername: USERNAME,
  });
  const service = { getStatus: jest.fn(async () => status()) };
  const controller = new MixpanelCohortsController(service as never, {} as never, {} as never);

  it("hides the service account's username from a member", async () => {
    expect(await controller.getStatus(PROJECT, access('member'))).toEqual({
      ...status(),
      serviceAccountUsername: HIDDEN_DURING_IMPERSONATION,
    });
  });

  it('shows it to an admin and an owner', async () => {
    expect(await controller.getStatus(PROJECT, access('admin'))).toEqual(status());
    expect(await controller.getStatus(PROJECT, access('owner'))).toEqual(status());
  });

  it('still hides it from view-as of the owner', async () => {
    const result = await controller.getStatus(PROJECT, access('owner', true));
    expect(result.serviceAccountUsername).toBe(HIDDEN_DURING_IMPERSONATION);
  });
});
