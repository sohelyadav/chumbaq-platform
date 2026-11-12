import { registerAs } from '@nestjs/config';

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export default registerAs('app', () => {
  const corsOriginsRaw = requireEnv('CORS_ORIGINS');
  const corsOrigins = corsOriginsRaw
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  if (corsOrigins.length === 0) {
    throw new Error('CORS_ORIGINS must contain at least one origin');
  }

  const nodeEnv = process.env.NODE_ENV || 'development';

  return {
    port: parseInt(requireEnv('API_PORT'), 10),
    baseUrl: requireEnv('API_BASE_URL'),
    shortLinkDomain: requireEnv('SHORT_LINK_DOMAIN'),
    appUrl: requireEnv('APP_URL'),
    corsOrigins,
    nodeEnv,
    // On unless developing. AUTH_COOKIE_SECURE=false is for a deployment with no HTTPS,
    // where a Secure cookie would be dropped and everyone signed out after 15 minutes.
    authCookieSecure:
      process.env.AUTH_COOKIE_SECURE !== undefined
        ? process.env.AUTH_COOKIE_SECURE !== 'false'
        : nodeEnv !== 'development' && nodeEnv !== 'test',
    geoipEnabled: process.env.GEOIP_ENABLED === 'true',
  };
});
