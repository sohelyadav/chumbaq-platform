import 'reflect-metadata';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { EmailController } from './email.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';
const TOKEN = 'ab'.repeat(24);

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

describe('EmailController route permissions', () => {
  const param = { param: 'projectId' };
  const body = { body: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['getSettings', 'project.read', param],
    ['updateSettings', 'channels.manage', body],
    ['connectProvider', 'channels.manage', body],
    ['resetSesTopic', 'channels.manage', param],
    ['rotateWebhookToken', 'channels.manage', param],
    ['previewAudience', 'messaging.write', body],
    ['send', 'messaging.write', body],
    ['testSend', 'messaging.write', body],
    ['listSuppressions', 'project.read', param],
    ['addSuppression', 'messaging.write', body],
    ['removeSuppression', 'messaging.write', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(EmailController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(EmailController)).toEqual(table.map(([h]) => h).sort());
  });
});

describe('EmailController settings read', () => {
  // Shaped like EmailSettingsService.status for a project on Resend.
  const status = () => ({
    configured: true,
    settings: {
      id: 'c1d2e3f4-0000-4000-8000-000000000001',
      projectId: PROJECT,
      provider: 'resend',
      fromEmail: 'news@acme.example',
      fromName: 'Acme',
      replyTo: null,
      postalAddress: '1 Main St',
      requireOptIn: false,
      sesTopicArn: null,
    },
    providers: [{ provider: 'resend', keyHint: 'x9Q2', hasWebhookSecret: true }],
    webhookUrls: {
      ses: `https://api.example/api/email/webhooks/ses/${TOKEN}`,
      resend: `https://api.example/api/email/webhooks/resend/${TOKEN}`,
      brevo: `https://api.example/api/email/webhooks/brevo/${TOKEN}`,
    },
    readyToSend: true,
  });
  const settings = { status: jest.fn(async () => status()) };
  const controller = new EmailController(settings as never, {} as never, {} as never);

  it('hides the webhook URLs, which carry the token, from a member', async () => {
    const result = await controller.getSettings(PROJECT, access('member'));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(result.webhookUrls).toEqual({
      ses: HIDDEN_DURING_IMPERSONATION,
      resend: HIDDEN_DURING_IMPERSONATION,
      brevo: HIDDEN_DURING_IMPERSONATION,
    });
    expect(result.settings).toEqual(status().settings);
  });

  it('shows them to an admin and an owner', async () => {
    expect(await controller.getSettings(PROJECT, access('admin'))).toEqual(status());
    expect(await controller.getSettings(PROJECT, access('owner'))).toEqual(status());
  });

  it('still hides them from view-as of the owner', async () => {
    const result = await controller.getSettings(PROJECT, access('owner', true));
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});
