import 'reflect-metadata';
import { HIDDEN_DURING_IMPERSONATION } from '../../common/impersonation-redaction';
import { PROJECT_PERMISSION_KEY } from '../project-access/require-project-permission.decorator';
import type { ProjectAccess } from '../project-access/project-access.service';
import { roleCan, type ProjectRole } from '../project-access/project-permissions';
import { WhatsAppController } from './whatsapp.controller';

const PROJECT = '9b0c3c4e-5f1a-4f55-9a43-3d2f0d7e8a11';
const TOKEN = 'ef'.repeat(24);
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

describe('WhatsAppController route permissions', () => {
  const param = { param: 'projectId' };
  const body = { body: 'projectId' };
  const table: Array<[string, string, object]> = [
    ['getSettings', 'project.read', param],
    ['updateSettings', 'channels.manage', body],
    ['connectProvider', 'channels.manage', body],
    ['templates', 'project.read', param],
    ['previewAudience', 'messaging.write', body],
    ['send', 'messaging.write', body],
    ['testSend', 'messaging.write', body],
    ['listSuppressions', 'project.read', param],
    ['addSuppression', 'messaging.write', body],
    ['removeSuppression', 'messaging.write', param],
  ];

  it.each(table)('%s needs %s', (handler, permission, from) => {
    expect(declared(WhatsAppController, handler)).toEqual({ permission, from });
  });

  it('has a row for every handler', () => {
    expect(handlersOf(WhatsAppController)).toEqual(table.map(([h]) => h).sort());
  });
});

describe('WhatsAppController settings read', () => {
  const url = (provider: string) => `https://api.example/api/whatsapp/webhooks/${provider}/${TOKEN}`;
  // Shaped like WhatsAppSettingsService.status with Meta and Twilio connected.
  const status = () => ({
    configured: true,
    settings: {
      id: 'c1d2e3f4-0000-4000-8000-000000000003',
      projectId: PROJECT,
      provider: 'meta',
      requireOptIn: true,
    },
    providers: [
      {
        provider: 'meta',
        identifiers: { phoneNumberId: '104857600000001', businessAccountId: '204857600000002' },
        keyHint: 'ZD9a',
        webhooksSigned: true,
      },
      {
        provider: 'twilio_whatsapp',
        identifiers: { accountSid: ACCOUNT_SID, sender: 'whatsapp:+14155550100' },
        keyHint: 'beef',
        webhooksSigned: true,
      },
    ],
    webhookUrls: {
      meta: url('meta'),
      twilio_whatsapp: url('twilio'),
      gupshup: url('gupshup'),
      interakt: url('interakt'),
    },
    verifyToken: TOKEN,
    webhooksReachable: true,
    readyToSend: true,
  });
  const settings = { status: jest.fn(async () => status()) };
  const controller = new WhatsAppController(settings as never, {} as never, {} as never);

  it('hides the webhook URLs, the verify token and the Twilio account SID from a member', async () => {
    const result = await controller.getSettings(PROJECT, access('member'));
    const text = JSON.stringify(result);
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(ACCOUNT_SID);
    expect(result.verifyToken).toBe(HIDDEN_DURING_IMPERSONATION);
    expect(Object.values(result.webhookUrls!)).toEqual(Array(4).fill(HIDDEN_DURING_IMPERSONATION));
    expect(result.providers[1].identifiers).toEqual({
      accountSid: HIDDEN_DURING_IMPERSONATION,
      sender: 'whatsapp:+14155550100',
    });
    // Meta's ids name the number and the business; they authenticate nothing.
    expect(result.providers[0]).toEqual(status().providers[0]);
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
