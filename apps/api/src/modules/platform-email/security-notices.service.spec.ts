import { ConfigService } from '@nestjs/config';
import { PlatformEmailResult, PlatformEmailService } from './platform-email.service';
import { SecurityNoticesService } from './security-notices.service';

const USER = { id: 'u1', email: 'owner@example.com', name: 'Owner' };

/**
 * The factor reset's wait starts only from a warning this reports as sent, so what it
 * reports has to be exactly what the provider said, and a throw must read as not sent.
 */
describe('SecurityNoticesService factor reset warning', () => {
  const config = { getOrThrow: () => 'https://app.example.com' } as unknown as ConfigService;
  const notices = (send: () => Promise<PlatformEmailResult>, isConfigured = true) =>
    new SecurityNoticesService({ send, isConfigured } as unknown as PlatformEmailService, config);

  it('reports a send the provider accepted', async () => {
    const send = jest.fn(async () => ({ sent: true }) as const);
    await expect(notices(send).sendFactorResetRequested(USER, new Date())).resolves.toBe(true);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: USER.email }));
  });

  it.each(['not_configured', 'refused', 'unreachable'] as const)('reports %s as not sent', async (reason) => {
    const send = async () => ({ sent: false, reason }) as const;
    await expect(notices(send).sendFactorResetRequested(USER, new Date())).resolves.toBe(false);
  });

  it('reports a throw as not sent, rather than failing the caller', async () => {
    const send = async (): Promise<PlatformEmailResult> => {
      throw new Error('boom');
    };
    await expect(notices(send).sendFactorResetRequested(USER, new Date())).resolves.toBe(false);
  });

  it('says whether account email is set up', () => {
    const send = async () => ({ sent: true }) as const;
    expect(notices(send, true).canSend()).toBe(true);
    expect(notices(send, false).canSend()).toBe(false);
  });
});

/**
 * Most owners have a live session when this arrives, and the sign-in page sends anyone
 * signed in straight on to their projects, so a button to /login cancelled nothing.
 */
describe('SecurityNoticesService staff reset link notice', () => {
  const config = { getOrThrow: () => 'https://app.example.com' } as unknown as ConfigService;

  it('points its button at the cancel page, never at sign-in or the link itself', async () => {
    const send = jest.fn(async (_email: { text: string; html: string }) => ({ sent: true }) as const);
    const notices = new SecurityNoticesService({ send, isConfigured: true } as unknown as PlatformEmailService, config);

    await expect(notices.sendStaffResetLinkIssued(USER, new Date('2026-11-09T14:30:00Z'))).resolves.toBe(true);

    const [{ text, html }] = send.mock.calls[0];
    for (const part of [text, html]) {
      expect(part).toContain('https://app.example.com/account/cancel-support-link');
      expect(part).not.toContain('/login');
      expect(part).not.toContain('reset-password');
    }
  });
});
