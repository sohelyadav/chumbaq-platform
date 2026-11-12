import express = require('express');
import type { Request } from 'express';
import { getClientIp, TRUST_PROXY } from './client-ip';

/**
 * These run against a real Express instance configured exactly as `main.ts`
 * configures it, because the whole question is what Express's own
 * `trust proxy` resolution does with a header an attacker partly controls.
 * Asserting that against a hand-rolled stand-in would prove nothing about the
 * deployed endpoint.
 */
function requestFrom(socketAddress: string, forwardedFor?: string): Request {
  const app = express();
  app.set('trust proxy', TRUST_PROXY);

  const socket = { remoteAddress: socketAddress };
  const req: Record<string, unknown> = Object.create(express.request);
  req.app = app;
  req.headers =
    forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor };
  req.socket = socket;
  // proxy-addr reads the legacy alias too, and express's own typings still
  // declare it, so both have to point at the same fake.
  req.connection = socket;

  return req as unknown as Request;
}

describe('getClientIp', () => {
  describe('behind the deployment’s Nginx (loopback peer)', () => {
    it('takes the address Nginx observed, not the one the client prepended', () => {
      // Nginx sets `X-Forwarded-For $proxy_add_x_forwarded_for`, which appends
      // its own view to whatever arrived. A client that sends
      // `X-Forwarded-For: 203.0.113.7` therefore produces exactly this header,
      // and the leftmost entry — which the old hand-rolled derivation took —
      // is the invented one.
      const ip = getClientIp(requestFrom('127.0.0.1', '203.0.113.7, 198.51.100.5'));

      expect(ip).toBe('198.51.100.5');
    });

    it('takes the only entry when the client sent no header of its own', () => {
      expect(getClientIp(requestFrom('127.0.0.1', '198.51.100.5'))).toBe(
        '198.51.100.5',
      );
    });

    it('resolves the same way over IPv6 loopback', () => {
      // Nginx proxying to 127.0.0.1 can still reach a dual-stack listener as
      // ::1, and the trust decision has to survive that.
      expect(
        getClientIp(requestFrom('::1', '203.0.113.7, 198.51.100.5')),
      ).toBe('198.51.100.5');
      expect(
        getClientIp(
          requestFrom('::ffff:127.0.0.1', '203.0.113.7, 198.51.100.5'),
        ),
      ).toBe('198.51.100.5');
    });

    it('falls back to the socket when there is no header at all', () => {
      expect(getClientIp(requestFrom('127.0.0.1'))).toBe('127.0.0.1');
    });
  });

  describe('exposed directly, with no proxy in front', () => {
    it('ignores X-Forwarded-For entirely', () => {
      // This is why TRUST_PROXY names a class of address rather than a hop
      // count: with `1`, this request would be attributed to 203.0.113.7 on
      // the attacker's word alone.
      expect(getClientIp(requestFrom('198.51.100.9', '203.0.113.7'))).toBe(
        '198.51.100.9',
      );
    });

    it('ignores a long forged chain just as completely', () => {
      expect(
        getClientIp(
          requestFrom('198.51.100.9', '203.0.113.7, 203.0.113.8, 203.0.113.9'),
        ),
      ).toBe('198.51.100.9');
    });
  });

  it('returns an empty string rather than undefined when there is no socket', () => {
    // Callers store this on a click row and compare it later; `undefined`
    // would stringify into a column and match nothing.
    expect(getClientIp({} as Request)).toBe('');
  });
});
