import { registerAs } from '@nestjs/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};
const UNIT_ALIASES: Record<string, string> = {
  msec: 'ms', msecs: 'ms', millisecond: 'ms', milliseconds: 'ms',
  sec: 's', secs: 's', second: 's', seconds: 's',
  min: 'm', mins: 'm', minute: 'm', minutes: 'm',
  hr: 'h', hrs: 'h', hour: 'h', hours: 'h',
  day: 'd', days: 'd',
  week: 'w', weeks: 'w',
};

/**
 * A lifetime as `jsonwebtoken` reads it ('7d', '12 hours', or a bare number of
 * milliseconds), in milliseconds. Throws on anything else, so a typo fails at start-up
 * and not as sessions that seem to last forever.
 */
export function durationMs(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/i.exec(value.trim());
  const unit = match && (match[2] ? match[2].toLowerCase() : 'ms');
  const factor = unit && (UNIT_MS[unit] ?? UNIT_MS[UNIT_ALIASES[unit]]);
  if (!match || !factor) throw new Error(`Cannot read the duration "${value}"`);
  return Number(match[1]) * factor;
}

/** What the services assume if config somehow lacks these, matching the defaults below. */
export const DEFAULT_REFRESH_LIFETIME_MS = 7 * UNIT_MS.d;
export const DEFAULT_SESSION_MAX_AGE_MS = 30 * UNIT_MS.d;

export default registerAs('jwt', () => {
  const secret = requireEnv('JWT_SECRET');
  if (secret.length < 32) {
    throw new Error('JWT_SECRET must be at least 32 characters');
  }
  // Its own key, so nothing that can make an access token can make a refresh token,
  // and the two can be rotated apart.
  const refreshSecret = requireEnv('JWT_REFRESH_SECRET');
  if (refreshSecret.length < 32) {
    throw new Error('JWT_REFRESH_SECRET must be at least 32 characters');
  }
  if (refreshSecret === secret) {
    throw new Error('JWT_REFRESH_SECRET must differ from JWT_SECRET');
  }
  const refreshExpiration = process.env.JWT_REFRESH_EXPIRATION || '7d';
  const refreshLifetimeMs = durationMs(refreshExpiration);
  // However often it refreshes, a session ends this long after sign-in, so a stolen
  // refresh token kept in use is not good for ever.
  const sessionMaxAge = process.env.SESSION_MAX_AGE || '30d';
  const sessionMaxAgeMs = durationMs(sessionMaxAge);
  // Shorter would make every refresh token outlive its session, and hide the setting.
  if (sessionMaxAgeMs < refreshLifetimeMs) {
    throw new Error('SESSION_MAX_AGE must be at least JWT_REFRESH_EXPIRATION');
  }
  return {
    secret,
    refreshSecret,
    expiration: process.env.JWT_EXPIRATION || '15m',
    refreshExpiration,
    refreshLifetimeMs,
    sessionMaxAge,
    sessionMaxAgeMs,
  };
});
