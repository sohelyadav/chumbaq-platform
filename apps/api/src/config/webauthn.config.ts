import { registerAs } from '@nestjs/config';

/** Where `npm run dev:web` serves the dashboard. Applies only when APP_URL is localhost. */
const LOCAL_DASHBOARD = ['https://localhost:5173', 'http://localhost:5173'];

/**
 * The RP ID defaults to the dashboard's own hostname and cannot change afterwards:
 * every passkey is bound to it, so changing it strands them all. A parent domain would
 * also let code on any subdomain use them, so do not widen it without checking what
 * those subdomains serve.
 */
export default registerAs('webauthn', () => {
  const appUrl = process.env.APP_URL;
  if (!appUrl) throw new Error('Missing required environment variable: APP_URL');
  const origins = process.env.WEBAUTHN_ORIGINS
    ? process.env.WEBAUTHN_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [new URL(appUrl).origin, ...(new URL(appUrl).hostname === 'localhost' ? LOCAL_DASHBOARD : [])];

  return {
    rpId: process.env.WEBAUTHN_RP_ID || new URL(appUrl).hostname,
    rpName: process.env.WEBAUTHN_RP_NAME || 'Chumbaq',
    origins,
    /** Off until tenants have recovery codes (roadmap 17): a lost key would be a lost account. */
    forTenants: process.env.PASSKEYS_FOR_TENANTS === 'true',
    superAdminAllowSynced: process.env.SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS === 'true',
    superAdminPasskeyRequired: superAdminPasskeyRequired(process.env),
  };
});

/**
 * Staff must use passkeys (two device-bound keys) for the admin area. Always on in
 * production, so a stray env value cannot weaken it there; elsewhere on unless set to
 * exactly 'false', which only local dev and the integration suite should do.
 */
export function superAdminPasskeyRequired(env: NodeJS.ProcessEnv): boolean {
  if (env.NODE_ENV === 'production') return true;
  return env.SUPER_ADMIN_PASSKEY_REQUIRED !== 'false';
}
