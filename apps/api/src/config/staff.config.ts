import { registerAs } from '@nestjs/config';
import { durationMs } from './jwt.config';

/** STAFF_SESSION_MAX_AGE's default, for code that may run where this config is not loaded. */
export const DEFAULT_STAFF_SESSION_MAX_AGE_MS = 8 * 3_600_000;

/** Where `npm run dev:admin` serves the admin app. */
export const DEFAULT_ADMIN_APP_URL = 'https://localhost:5174';

export interface StaffConfig {
  adminApiPort: number;
  adminApiHost: string;
  adminAppUrl: string;
  /** Whether ADMIN_APP_URL was set, so `main-admin.ts` can refuse a production boot without it. */
  adminAppUrlSet: boolean;
  accessTtl: string;
  accessTtlMs: number;
  idleTimeoutMs: number;
  maxAgeMs: number;
  enrolmentTtlMs: number;
  cookieSecure: boolean;
  webauthn: { rpId: string; rpName: string; origins: string[] };
}

function port(raw: string | undefined): number {
  if (raw === undefined || raw === '') return 3011;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`ADMIN_API_PORT must be a port number, not "${raw}"`);
  }
  return value;
}

/**
 * The staff session: shorter than a customer's, because a staff session can see and act
 * on every tenant. Every value has a default, so neither API needs a new variable to boot.
 *
 * Read by both APIs: the customer API needs `maxAgeMs` to end a view-as token whose staff
 * session is over. Only the admin API serves the routes the rest is for.
 *
 * Staff passkeys have their own relying party, the admin app's host, because a passkey is
 * bound to the host it was made on: keys made in the customer app would not work on
 * admin.chumbaq.com. Like WEBAUTHN_RP_ID, STAFF_WEBAUTHN_RP_ID cannot change once staff
 * keys exist.
 */
/** URL hostnames come normalised: IPv4 as four decimal parts, IPv6 in brackets. */
function isIpAddress(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

/**
 * True when `host` may use `rpId` as its relying party: the same name, or a name under
 * it (`a.example.com` is under `example.com`). An IP address has no parent domain, so
 * the browser takes it only as an exact match: 0.0.5 is no relying party for 10.0.0.5.
 */
function onRelyingParty(host: string, rpId: string): boolean {
  if (host === rpId) return true;
  return !isIpAddress(host) && host.endsWith(`.${rpId}`);
}

/** Loopback and unspecified addresses, as URL hostnames, with one trailing dot taken off. */
function isThisMachine(hostname: string): boolean {
  const host = hostname.replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    /^127\./.test(host) ||
    host === '0.0.0.0' ||
    host === '[::1]' ||
    host === '[::]' ||
    // IPv4-mapped 127.x.x.x and 0.0.0.0, as the URL parser writes them.
    /^\[::ffff:(7f[0-9a-f]{2}:[0-9a-f]{1,4}|0:0)\]$/.test(host)
  );
}

/**
 * What stops the admin API booting in production. A relying party or origin list that
 * does not match the host nginx serves the admin app on makes every staff passkey
 * ceremony fail, and nobody can sign in to fix it, so refuse to start rather than run.
 * Only the admin API calls this, so the customer API never needs ADMIN_APP_URL.
 *
 * Without the public suffix list a single-label RP ID ("com") is the one public suffix
 * refused here; the browser refuses the rest at the first ceremony.
 */
export function staffProductionProblems(staff: StaffConfig): string[] {
  if (!staff.adminAppUrlSet) return ['ADMIN_APP_URL is required for the admin API in production'];

  const app = new URL(staff.adminAppUrl);
  const host = app.hostname.toLowerCase();
  // Said on its own: comparing the RP ID with a localhost host only produces a riddle.
  if (isThisMachine(host)) {
    return [
      `ADMIN_APP_URL cannot point at this machine (${app.origin}) in production: set it to the admin host, e.g. https://admin.example.com`,
    ];
  }

  const problems: string[] = [];
  const rpId = staff.webauthn.rpId.toLowerCase();

  if (isIpAddress(host)) {
    if (rpId !== host) {
      problems.push(
        `STAFF_WEBAUTHN_RP_ID "${staff.webauthn.rpId}" must be "${host}": an IP address only matches itself`,
      );
    }
  } else if (!rpId.includes('.') || rpId.startsWith('.') || rpId.endsWith('.') || !onRelyingParty(host, rpId)) {
    problems.push(
      `STAFF_WEBAUTHN_RP_ID "${staff.webauthn.rpId}" must be "${host}" (the ADMIN_APP_URL host) or a domain it is under`,
    );
  }
  if (!staff.webauthn.origins.includes(app.origin)) {
    problems.push(`STAFF_WEBAUTHN_ORIGINS must include ${app.origin}, the origin of ADMIN_APP_URL`);
  }
  for (const origin of staff.webauthn.origins) {
    let originHost: string | null = null;
    try {
      originHost = new URL(origin).hostname.toLowerCase();
    } catch {
      // Reported just below like any other origin off the relying party.
    }
    if (origin !== app.origin && (originHost === null || !onRelyingParty(originHost, rpId))) {
      problems.push(`STAFF_WEBAUTHN_ORIGINS: ${origin} is not on ${rpId} (STAFF_WEBAUTHN_RP_ID)`);
    }
  }
  return problems;
}

/**
 * The admin API's boot gate, kept here rather than inline in `main-admin.ts` so it is
 * unit-tested. In production it throws with every problem, one per line; elsewhere it
 * does nothing, so dev keeps working on the localhost defaults.
 */
export function assertStaffProductionConfig(nodeEnv: string | undefined, staff: StaffConfig): void {
  if (nodeEnv !== 'production') return;
  const problems = staffProductionProblems(staff);
  if (problems.length > 0) throw new Error(problems.join('\n'));
}

export default registerAs('staff', (): StaffConfig => {
  const adminAppUrl = process.env.ADMIN_APP_URL || DEFAULT_ADMIN_APP_URL;
  const parsed = new URL(adminAppUrl);

  const accessTtl = process.env.STAFF_ACCESS_TOKEN_TTL || '10m';
  const accessTtlMs = durationMs(accessTtl);
  const idleTimeoutMs = durationMs(process.env.STAFF_IDLE_TIMEOUT || '30m');
  const maxAgeMs = durationMs(process.env.STAFF_SESSION_MAX_AGE || '8h');
  const enrolmentTtlMs = durationMs(process.env.STAFF_ENROLMENT_SESSION_TTL || '15m');

  // An access token living longer than the idle limit would keep a session going that
  // the idle rule already ended, and the same for the absolute end.
  if (accessTtlMs > idleTimeoutMs) {
    throw new Error('STAFF_ACCESS_TOKEN_TTL must not exceed STAFF_IDLE_TIMEOUT');
  }
  if (idleTimeoutMs > maxAgeMs) {
    throw new Error('STAFF_IDLE_TIMEOUT must not exceed STAFF_SESSION_MAX_AGE');
  }

  const origins = process.env.STAFF_WEBAUTHN_ORIGINS
    ? process.env.STAFF_WEBAUTHN_ORIGINS.split(',').map((origin) => origin.trim()).filter(Boolean)
    : [parsed.origin];

  return {
    adminApiPort: port(process.env.ADMIN_API_PORT),
    adminApiHost: process.env.ADMIN_API_HOST || '127.0.0.1',
    adminAppUrl,
    adminAppUrlSet: Boolean(process.env.ADMIN_APP_URL),
    accessTtl,
    accessTtlMs,
    idleTimeoutMs,
    maxAgeMs,
    enrolmentTtlMs,
    // On unless set to exactly 'false': the admin dev server is https, so Secure works
    // in development too.
    cookieSecure: process.env.STAFF_COOKIE_SECURE !== 'false',
    webauthn: {
      rpId: process.env.STAFF_WEBAUTHN_RP_ID || parsed.hostname,
      rpName: process.env.STAFF_WEBAUTHN_RP_NAME || 'Chumbaq Admin',
      origins,
    },
  };
});
