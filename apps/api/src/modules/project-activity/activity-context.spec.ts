import type { Request } from 'express';
import { activityContext } from './activity-context';

const request = (ip: string | undefined, userAgent?: string | string[]) =>
  ({ ip, socket: { remoteAddress: '10.9.9.9' }, headers: userAgent === undefined ? {} : { 'user-agent': userAgent } }) as unknown as Request;

describe('activityContext', () => {
  it('takes the address from getClientIp, never from the body', () => {
    const req = request('203.0.113.9', 'Mozilla/5.0');
    (req as unknown as { body: unknown }).body = { ipAddress: '198.51.100.1' };
    expect(activityContext(req)).toEqual({ ipAddress: '203.0.113.9', userAgent: 'Mozilla/5.0' });
  });

  it('falls back to the socket address, as getClientIp does', () => {
    expect(activityContext(request(undefined)).ipAddress).toBe('10.9.9.9');
  });

  it('cuts the user agent to 512 characters', () => {
    expect(activityContext(request('203.0.113.9', 'x'.repeat(2000))).userAgent).toHaveLength(512);
  });

  it('has no user agent when the header is missing', () => {
    expect(activityContext(request('203.0.113.9')).userAgent).toBeNull();
  });
});
