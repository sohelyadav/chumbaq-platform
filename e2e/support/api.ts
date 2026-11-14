import { randomBytes } from 'crypto';
import { signSignupToken, signupKey } from '../../apps/api/src/modules/auth/signup-token';
import { runSecrets } from './stack';

/**
 * Node-side helpers that set things up through the real API, for the steps a spec is
 * not about. Every request carries an `X-Forwarded-For` the caller chooses: the API
 * trusts it from a loopback peer (as it does behind nginx), so each test counts against
 * the per-address rate limits as its own client, and tests cannot throttle each other.
 */

export function apiUrl(path: string): string {
  const base = process.env.E2E_API_URL;
  if (!base) throw new Error('E2E_API_URL is not set: run the specs through playwright.config.ts');
  return `${base}${path}`;
}

/** A private address no other test will draw, for X-Forwarded-For. */
export function newClientIp(): string {
  const [a, b, c] = randomBytes(3);
  return `10.${a}.${b}.${Math.max(1, c % 254)}`;
}

export function uniqueEmail(label: string): string {
  return `${label}-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}@e2e.example.test`;
}

export const PASSWORD = 'e2e-Password-123!';

export interface ApiOptions {
  token?: string;
  apiKey?: string;
  ip: string;
}

/** A JSON request; answers the `data` of the API's `{ data }` envelope, or throws with the body. */
export async function api<T = unknown>(
  method: string,
  path: string,
  body: unknown,
  { token, apiKey, ip }: ApiOptions,
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Chumbaq-Client': 'web',
      'X-Forwarded-For': ip,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(apiKey ? { 'X-API-Key': apiKey } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${text.slice(0, 500)}`);
  if (!text) return undefined as T;
  const parsed = JSON.parse(text) as { data?: T };
  return (parsed.data ?? parsed) as T;
}

/**
 * The link the API would have mailed for a sign-up, made with the run's JWT secret
 * (globalSetup hands it to the API). Account email is off in the e2e stack, so this is
 * how a test gets the second step of signing up.
 */
export function signupLinkToken(email: string, name: string): string {
  return signSignupToken(signupKey(runSecrets().jwtSecret), { email, name });
}

export interface Account {
  email: string;
  name: string;
  password: string;
  userId: string;
  accessToken: string;
}

/** Registers and completes the sign-up through the API, as the form and the emailed link would. */
export async function createAccount(ip: string, label = 'user', name = 'E2E Person'): Promise<Account> {
  const email = uniqueEmail(label);
  await api('POST', '/api/auth/register', { email, name }, { ip });
  const signedIn = await api<{ user: { id: string }; tokens: { accessToken: string } }>(
    'POST',
    '/api/auth/complete-signup',
    { token: signupLinkToken(email, name), password: PASSWORD },
    { ip },
  );
  return { email, name, password: PASSWORD, userId: signedIn.user.id, accessToken: signedIn.tokens.accessToken };
}

export interface Project {
  id: string;
  name: string;
}

export async function createProject(account: Account, ip: string, name = `E2E project ${randomBytes(2).toString('hex')}`): Promise<Project> {
  const project = await api<{ id: string; name: string }>(
    'POST',
    '/api/projects',
    { name, domain: 'e2e.example.test' },
    { token: account.accessToken, ip },
  );
  return { id: project.id, name: project.name };
}

export async function createApiKey(account: Account, projectId: string, ip: string): Promise<string> {
  const created = await api<{ fullKey: string }>(
    'POST',
    `/api/projects/${projectId}/api-keys`,
    { name: 'E2E SDK key' },
    { token: account.accessToken, ip },
  );
  return created.fullKey;
}
