import { createHmac } from 'crypto';
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { SmsPublicController } from './sms-public.controller';

const TOKEN = 'a'.repeat(48);
const AUTH = 'f'.repeat(32);
const SID = `AC${'1'.repeat(32)}`;
const BASE = 'https://api.chumbaq.example';
const c = '11111111-1111-4111-8111-111111111111';
const i = '22222222-2222-4222-8222-222222222222';

function sign(url: string, params: Record<string, string>, key = AUTH): string {
  const payload = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return createHmac('sha1', key).update(payload).digest('base64');
}

function request(path: string, body: Record<string, string>, signature?: string, query = {}) {
  return {
    originalUrl: path,
    body,
    query,
    header: (name: string) => (name === 'x-twilio-signature' ? signature : undefined),
  } as never;
}

function response() {
  const res: any = {};
  res.status = jest.fn(() => res);
  res.type = jest.fn(() => res);
  res.send = jest.fn(() => res);
  return res;
}

describe('SmsPublicController', () => {
  const settings = {
    findByWebhookToken: jest.fn(),
    credentialsFor: jest.fn(),
    baseUrl: jest.fn(() => BASE),
  };
  const events = { ingest: jest.fn(), keyword: jest.fn() };
  let controller: SmsPublicController;

  beforeEach(() => {
    jest.clearAllMocks();
    settings.findByWebhookToken.mockResolvedValue({ id: 's1', projectId: 'proj-1', webhookToken: TOKEN });
    settings.credentialsFor.mockResolvedValue({ accountSid: SID, authToken: AUTH });
    controller = new SmsPublicController(settings as never, events as never);
  });

  const statusPath = `/api/sms/webhooks/twilio/${TOKEN}/status?c=${c}&i=${i}`;
  const statusBody = { AccountSid: SID, To: '+14155550000', MessageStatus: 'delivered' };

  it('records a delivery report signed over the public URL, query included', async () => {
    const req = request(statusPath, statusBody, sign(BASE + statusPath, statusBody), { c, i });

    await controller.status(TOKEN, req);

    expect(events.ingest).toHaveBeenCalledWith(
      'proj-1',
      'twilio',
      expect.objectContaining({ type: 'delivered', campaignId: c, identityId: i }),
    );
  });

  it('refuses a report whose campaign id was swapped after signing', async () => {
    const other = '33333333-3333-4333-8333-333333333333';
    const signature = sign(BASE + statusPath, statusBody);
    const forged = statusPath.replace(c, other);

    await expect(
      controller.status(TOKEN, request(forged, statusBody, signature, { c: other, i })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(events.ingest).not.toHaveBeenCalled();
  });

  it('refuses a request signed with a different auth token', async () => {
    const req = request(statusPath, statusBody, sign(BASE + statusPath, statusBody, '0'.repeat(32)), { c, i });
    await expect(controller.status(TOKEN, req)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('refuses an unknown token before anything else', async () => {
    settings.findByWebhookToken.mockResolvedValueOnce(null);
    await expect(controller.status('nope', request(statusPath, statusBody))).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(settings.credentialsFor).not.toHaveBeenCalled();
  });

  it('refuses webhooks until Twilio is connected, since nothing could verify them', async () => {
    settings.credentialsFor.mockResolvedValueOnce(null);
    await expect(
      controller.status(TOKEN, request(statusPath, statusBody, 'x')),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('refuses a validly signed request for another Twilio account', async () => {
    const body = { ...statusBody, AccountSid: `AC${'9'.repeat(32)}` };
    const req = request(statusPath, body, sign(BASE + statusPath, body), { c, i });
    await expect(controller.status(TOKEN, req)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('records a STOP reply and answers with empty TwiML', async () => {
    const path = `/api/sms/webhooks/twilio/${TOKEN}/inbound`;
    const body = { AccountSid: SID, From: '+14155550000', Body: 'STOP' };
    const res = response();

    await controller.inbound(TOKEN, request(path, body, sign(BASE + path, body)), res);

    expect(events.keyword).toHaveBeenCalledWith('proj-1', 'twilio', 'opt_out', '+14155550000');
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.send.mock.calls[0][0]).toContain('<Response></Response>');
  });

  it('answers an ordinary reply without recording anything', async () => {
    const path = `/api/sms/webhooks/twilio/${TOKEN}/inbound`;
    const body = { AccountSid: SID, From: '+14155550000', Body: 'Thanks!' };
    const res = response();

    await controller.inbound(TOKEN, request(path, body, sign(BASE + path, body)), res);

    expect(events.keyword).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(200);
  });
});
