import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { PlatformEmailResult, PlatformEmailService } from '../platform-email/platform-email.service';
import { AccountRecoveryService } from './account-recovery.service';

/**
 * With no platform email a sign-up link never arrives, so on a local install it goes to
 * the console. Anyone who reads that log could finish the sign-up, so it must never
 * happen in production, whatever else is set.
 */
describe('AccountRecoveryService.startSignup without platform email', () => {
  const EMAIL = 'new@example.com';
  let warn: jest.SpyInstance;
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warn.mockRestore();
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  function build(nodeEnv: string, result: PlatformEmailResult = { sent: false, reason: 'not_configured' }) {
    const values: Record<string, string> = {
      'app.nodeEnv': nodeEnv,
      'app.appUrl': 'http://localhost:5173',
      'jwt.secret': 'a-test-secret-that-is-long-enough-for-hmac',
    };
    const config = {
      get: (key: string) => values[key],
      getOrThrow: (key: string) => values[key],
    } as unknown as ConfigService;
    const email = { send: jest.fn(async () => result) } as unknown as PlatformEmailService;
    const users = { findByEmail: async () => null };
    const none = {} as never;
    const recovery = new AccountRecoveryService(users as never, none, none, email, none, config, none);
    return recovery;
  }

  const linkLines = () =>
    warn.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('/complete-signup'));

  it.each(['development', 'test'])('logs the link once in %s', async (nodeEnv) => {
    process.env.NODE_ENV = nodeEnv;
    const recovery = build(nodeEnv);
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    const lines = linkLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No platform email is set up');
    expect(lines[0]).toContain('http://localhost:5173/complete-signup');
  });

  it('never logs the link in production', async () => {
    process.env.NODE_ENV = 'production';
    const recovery = build('production');
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    expect(linkLines()).toHaveLength(0);
  });

  it('never logs the link when the process runs in production, whatever the app config says', async () => {
    process.env.NODE_ENV = 'production';
    const recovery = build('development');
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    expect(linkLines()).toHaveLength(0);
  });

  it('never logs the link when NODE_ENV is not set, though the app config reads that as development', async () => {
    delete process.env.NODE_ENV;
    const recovery = build('development');
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    expect(linkLines()).toHaveLength(0);
  });

  it('never logs the link in any other environment, such as staging', async () => {
    process.env.NODE_ENV = 'staging';
    const recovery = build('staging');
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    expect(linkLines()).toHaveLength(0);
  });

  it('never logs the link when email is set up but the send failed', async () => {
    process.env.NODE_ENV = 'development';
    const recovery = build('development', { sent: false, reason: 'unreachable' });
    recovery.startSignup(EMAIL, 'New');
    await recovery.settled();
    expect(linkLines()).toHaveLength(0);
  });
});
