import { isIPv6 } from 'net';
import type { Request } from 'express';
import { getClientIp } from './client-ip';

/**
 * Who a rate limit counts against: the client address, except that an IPv6 client
 * counts as its /64. A single subscriber is normally given a whole /64 (or more), so
 * keyed on the exact address every request could come from a fresh one and get a fresh
 * allowance. An IPv4-mapped IPv6 address counts as the IPv4 address it carries.
 */
export function throttleTracker(req: Record<string, unknown>): string {
  return rateLimitKey(getClientIp(req as unknown as Request));
}

export function rateLimitKey(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!isIPv6(ip)) return ip;
  const groups = expandIPv6(ip);
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : ip;
}

/** The eight 16-bit groups of an IPv6 address, lower case and unpadded, or null. */
function expandIPv6(ip: string): string[] | null {
  const address = ip.split('%')[0].toLowerCase();
  const [head, tail] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail !== undefined && tail !== '' ? tail.split(':') : [];
  if (address.includes('.')) return null;
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right];
  return groups.map((group) => (parseInt(group, 16) || 0).toString(16));
}
