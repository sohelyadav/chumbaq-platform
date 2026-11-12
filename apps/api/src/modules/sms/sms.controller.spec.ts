import 'reflect-metadata';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { SmsController } from './sms.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';
const TOKEN = 'cd'.repeat(24);
// Built, not written out: a literal in Twilio's SID shape trips secret scanners.
const ACCOUNT_SID = 'AC' + '0123456789abcdef'.repeat(2);

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

describe('SmsController route permissions', () => {
  const param = { param: 'projectId' };
  const body = { body: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['getSettings', 'project.read', param],
    ['updateSettings', 'channels.manage', body],
    ['connectProvider', 'channels.manage', body],
    ['previewAudience', 'messaging.write', body],
    ['send', 'messaging.write', body],
    ['testSend', 'messaging.write', body],
    ['listSuppressions', 'project.read', param],
    ['addSuppression', 'messaging.write', body],
    ['removeSuppression', 'messaging.write', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(SmsController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(SmsController)).toEqual(table.map(([h]) => h).sort());
  });
});

describe('SmsController settings read', () => {
  // Shaped like SmsSettingsService.status for a project on Twilio.
  const status = () => ({
    configured: true,
    settings: {
      id: 'c1d2e3f4-0000-4000-8000-000000000002',
      projectId: PROJECT,
      provider: 'twilio',
      sender: '+14155550100',
      requireOptIn: false,
      optOutText: null,
    },
    providers: [{ provider: 'twilio', accountSid: ACCOUNT_SID, keyHint: 'f00d' }],
    inboundWebhookUrl: `https://api.example/api/sms/webhooks/twilio/${TOKEN}/inbound`,
    webhooksReachable: true,
    readyToSend: true,
  });
  const settings = { status: jest.fn(async () => status()) };
  const controller = new SmsController(settings as never, {} as never, {} as never);

  it('hides the inbound URL and the Twilio account SID from a member', async () => {
    const result = await controller.getSettings(PROJECT, access('member'));
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT_SID);
    expect(result.inboundWebhookUrl).toBe(HIDDEN_DURING_IMPERSONATION);
    expect(result.providers).toEqual([
      { provider: 'twilio', accountSid: HIDDEN_DURING_IMPERSONATION, keyHint: 'f00d' },
    ]);
    expect(result.settings).toEqual(status().settings);
  });

  it('shows them to an admin and an owner', async () => {
    expect(await controller.getSettings(PROJECT, access('admin'))).toEqual(status());
    expect(await controller.getSettings(PROJECT, access('owner'))).toEqual(status());
  });

  it('still hides them from view-as of the owner', async () => {
    const text = JSON.stringify(await controller.getSettings(PROJECT, access('owner', true)));
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT_SID);
  });
});
