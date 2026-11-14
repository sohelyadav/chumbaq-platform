import { registerAs } from '@nestjs/config';

/**
 * Where each outbound provider's API is reached, with a test-only override per host.
 *
 * Every provider talks to a fixed host. For end-to-end tests each one can be pointed at
 * a local stub with its `*_API_BASE_URL` variable, which replaces the default exactly
 * (path included). An override is refused unless `NODE_ENV` is `development` or `test`,
 * so no deployed install can send a tenant's credentials or Chumbaq's own account-email
 * key anywhere else: the API, the admin API and the worker refuse to boot, and a call
 * made with a refused value throws before any request.
 *
 * Amazon SES, STS and SNS are deliberately not here: their requests are signed for, and
 * their certificates checked against, AWS's own hosts.
 */
export const PROVIDER_ENDPOINTS = {
  /** Chumbaq's own account email (`platform-email`). */
  platformBrevo: { variable: 'PLATFORM_BREVO_API_BASE_URL', defaultUrl: 'https://api.brevo.com/v3' },
  /** Tenants' Brevo email campaigns. */
  brevo: { variable: 'BREVO_API_BASE_URL', defaultUrl: 'https://api.brevo.com/v3' },
  resend: { variable: 'RESEND_API_BASE_URL', defaultUrl: 'https://api.resend.com' },
  /** Twilio's REST API: SMS and Twilio WhatsApp. */
  twilio: { variable: 'TWILIO_API_BASE_URL', defaultUrl: 'https://api.twilio.com/2010-04-01' },
  /** Twilio's Content API: WhatsApp template lists. */
  twilioContent: { variable: 'TWILIO_CONTENT_API_BASE_URL', defaultUrl: 'https://content.twilio.com/v1' },
  /** Meta's Graph API host; the pinned Graph version is added after it. */
  metaGraph: { variable: 'META_GRAPH_API_BASE_URL', defaultUrl: 'https://graph.facebook.com' },
  gupshup: { variable: 'GUPSHUP_API_BASE_URL', defaultUrl: 'https://api.gupshup.io' },
  interakt: { variable: 'INTERAKT_API_BASE_URL', defaultUrl: 'https://api.interakt.ai/v1/public' },
  mixpanel: { variable: 'MIXPANEL_API_BASE_URL', defaultUrl: 'https://mixpanel.com/api/2.0' },
  /** FCM v1 sends. */
  fcm: { variable: 'FCM_API_BASE_URL', defaultUrl: 'https://fcm.googleapis.com' },
  /** Google's OAuth token exchange for FCM service accounts (`/token` is added). */
  googleOauth: { variable: 'GOOGLE_OAUTH2_API_BASE_URL', defaultUrl: 'https://oauth2.googleapis.com' },
} as const;

export type ProviderEndpoint = keyof typeof PROVIDER_ENDPOINTS;
export type ProviderEndpoints = Record<ProviderEndpoint, string>;

function read(env: Record<string, string | undefined>, name: string): string | null {
  const value = env[name]?.trim();
  return value ? value : null;
}

/** The override for one provider, checked as `RAZORPAY_API_BASE_URL` is. Never names the value. */
function overrideOf(env: Record<string, string | undefined>, name: ProviderEndpoint): string | null {
  const { variable } = PROVIDER_ENDPOINTS[name];
  const raw = read(env, variable);
  if (raw === null) return null;
  const nodeEnv = read(env, 'NODE_ENV');
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error(`${variable} is only allowed when NODE_ENV is development or test`);
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be an http or https URL`);
  }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.search || url.hash) {
    throw new Error(`${variable} must be an http or https URL`);
  }
  return raw.replace(/\/+$/, '');
}

/** Every provider's base URL: the override where one is set (and allowed), else the provider's own. */
export function readProviderEndpoints(env: Record<string, string | undefined>): ProviderEndpoints {
  const out = {} as ProviderEndpoints;
  for (const name of Object.keys(PROVIDER_ENDPOINTS) as ProviderEndpoint[]) {
    out[name] = overrideOf(env, name) ?? PROVIDER_ENDPOINTS[name].defaultUrl;
  }
  return out;
}

/**
 * One provider's base URL, read when a request is made (providers are built without the
 * config service). Throws on a refused override; boot has already refused one.
 */
export function providerBaseUrl(name: ProviderEndpoint, env: Record<string, string | undefined> = process.env): string {
  return overrideOf(env, name) ?? PROVIDER_ENDPOINTS[name].defaultUrl;
}

/** Loaded by the API, the admin API and the worker, so a refused override stops boot. */
export default registerAs('providerEndpoints', () => readProviderEndpoints(process.env));
