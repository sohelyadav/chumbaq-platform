import { rateLimitKey } from './throttle-tracker';

describe('rateLimitKey', () => {
  it('counts every address of one IPv6 /64 as one client', () => {
    const a = rateLimitKey('2001:db8:1:2:aaaa::1');
    expect(rateLimitKey('2001:db8:1:2:ffff:ffff:ffff:ffff')).toBe(a);
    expect(rateLimitKey('2001:0DB8:0001:0002::9')).toBe(a);
    expect(a).toBe('2001:db8:1:2::/64');
  });

  it('keeps different /64s apart', () => {
    expect(rateLimitKey('2001:db8:1:3::1')).not.toBe(rateLimitKey('2001:db8:1:2::1'));
  });

  it('expands :: anywhere', () => {
    expect(rateLimitKey('::1')).toBe('0:0:0:0::/64');
    expect(rateLimitKey('fe80::1%en0')).toBe('fe80:0:0:0::/64');
  });

  it('leaves IPv4 alone and unwraps IPv4-mapped addresses', () => {
    expect(rateLimitKey('203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(rateLimitKey('')).toBe('');
  });
});
