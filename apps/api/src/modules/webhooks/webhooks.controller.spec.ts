import 'reflect-metadata';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { WebhooksController } from './webhooks.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';
const HOOK_ID = '5d8f2a10-7c3e-4b9a-8f21-0a1b2c3d4e5f';
// Shaped like a real Slack incoming webhook: the path is the credential.
const HOOK_URL = 'https://hooks.slack.com/services/T0ACME/B0ACME/s3cr3tPathToken';

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

describe('WebhooksController route permissions', () => {
  const param = { param: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['create', 'channels.manage', param],
    ['findAll', 'project.read', param],
    ['findOne', 'project.read', param],
    ['update', 'channels.manage', param],
    ['rotateSecret', 'channels.manage', param],
    ['remove', 'channels.manage', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(WebhooksController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(WebhooksController)).toEqual(table.map(([h]) => h).sort());
  });
});

describe('WebhooksController reads', () => {
  // A stored row, sealed secret and all: the view must drop what it should.
  const row = () => ({
    id: HOOK_ID,
    projectId: PROJECT,
    url: HOOK_URL,
    events: ['conversion'],
    isActive: true,
    secretSealed: 'v1:sealed-ciphertext',
    secretHint: 'ffff',
    secretRotatedAt: null,
    createdAt: new Date('2026-11-01T10:00:00Z'),
    updatedAt: new Date('2026-11-01T10:00:00Z'),
  });
  const service = {
    findAllByProject: jest.fn(async () => [row()]),
    findOne: jest.fn(async () => row()),
  };
  const controller = new WebhooksController(service as never);

  const reads = (a: ProjectAccess) => Promise.all([
    controller.findAll(PROJECT, a).then((list) => list[0]),
    controller.findOne(PROJECT, HOOK_ID, a),
  ]);

  it('hides the receiver URL from a member, in the list and the single read', async () => {
    for (const view of await reads(access('member'))) {
      expect(view.url).toBe(HIDDEN_DURING_IMPERSONATION);
      expect(JSON.stringify(view)).not.toContain('hooks.slack.com');
      expect(view.secretHint).toBe('ffff');
      expect(view).not.toHaveProperty('secretSealed');
    }
  });

  it('shows it to an admin and an owner', async () => {
    for (const role of ['admin', 'owner'] as const) {
      for (const view of await reads(access(role))) expect(view.url).toBe(HOOK_URL);
    }
  });

  it('still hides it from view-as of the owner', async () => {
    for (const view of await reads(access('owner', true))) {
      expect(JSON.stringify(view)).not.toContain('s3cr3tPathToken');
    }
  });

  it('reads the hook within the project the guard checked', async () => {
    await controller.findOne(PROJECT, HOOK_ID, access('member'));
    expect(service.findOne).toHaveBeenLastCalledWith(HOOK_ID, PROJECT);
  });
});
