import { randomBytes, randomUUID } from 'crypto';
import http from 'http';
import type { Socket } from 'net';

/**
 * One local server standing in for every outbound provider the apps call: Chumbaq's own
 * account email (Brevo) and the tenants' channel providers (FCM and Google's token
 * exchange, Resend, Brevo, Twilio and its Content API, Meta's Graph API, Gupshup,
 * Interakt, Mixpanel). The apps reach it through the `*_API_BASE_URL` overrides, which
 * the API allows only in development and test (`provider-endpoints.config.ts`); each
 * provider gets a base of `<stub>/<provider>` followed by the real API's own path prefix,
 * so the stub sees the same paths the provider would.
 *
 * Every provider request is recorded (method, path, headers with credentials redacted,
 * parsed body) and answered in the provider's documented success shape. SES, STS and SNS
 * are not stubbed: their requests are signed for AWS's own hosts.
 *
 * Test controls, under `/__stub` (the stub is shared by every test of the run, so
 * filter calls by something your test owns, such as a recipient address, rather than
 * resetting everything):
 *
 * - `GET  /__stub/calls?provider=<name>`: the recorded calls, oldest first (all
 *   providers without `provider`).
 * - `POST /__stub/reset` `{ provider? }`: forgets calls, failures and answers (of one
 *   provider, or all).
 * - `POST /__stub/fail` `{ provider, status?, body?, timeout?, times?, match? }`: the next
 *   requests to `provider` answer `status` (with the provider's error shape, or `body`),
 *   or never answer when `timeout` is true; `times` of them (until reset when absent),
 *   and only requests whose path or body contains `match` when given.
 * - `POST /__stub/answer` `{ provider, method?, path, status?, body }`: requests to
 *   `provider` whose path starts with `path` get this answer instead of the default,
 *   until reset (for template lists, cohorts and the like).
 */

export const STUB_PROVIDERS = [
  'platform-brevo',
  'brevo',
  'resend',
  'twilio',
  'twilio-content',
  'meta',
  'gupshup',
  'interakt',
  'mixpanel',
  'fcm',
  'google-oauth',
] as const;
export type StubProvider = (typeof STUB_PROVIDERS)[number];

/** Each provider's override variable and the real API's path prefix after the stub's `/<provider>`. */
const BASES: Record<StubProvider, { variable: string; prefix: string }> = {
  'platform-brevo': { variable: 'PLATFORM_BREVO_API_BASE_URL', prefix: '/v3' },
  brevo: { variable: 'BREVO_API_BASE_URL', prefix: '/v3' },
  resend: { variable: 'RESEND_API_BASE_URL', prefix: '' },
  twilio: { variable: 'TWILIO_API_BASE_URL', prefix: '/2010-04-01' },
  'twilio-content': { variable: 'TWILIO_CONTENT_API_BASE_URL', prefix: '/v1' },
  meta: { variable: 'META_GRAPH_API_BASE_URL', prefix: '' },
  gupshup: { variable: 'GUPSHUP_API_BASE_URL', prefix: '' },
  interakt: { variable: 'INTERAKT_API_BASE_URL', prefix: '/v1/public' },
  mixpanel: { variable: 'MIXPANEL_API_BASE_URL', prefix: '/api/2.0' },
  fcm: { variable: 'FCM_API_BASE_URL', prefix: '' },
  'google-oauth': { variable: 'GOOGLE_OAUTH2_API_BASE_URL', prefix: '' },
};

/** The `*_API_BASE_URL` values that send every provider to the stub at `stubUrl`. */
export function providerStubEnvironment(stubUrl: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const provider of STUB_PROVIDERS) {
    const { variable, prefix } = BASES[provider];
    out[variable] = `${stubUrl}/${provider}${prefix}`;
  }
  return out;
}

export interface StubCall {
  provider: StubProvider;
  method: string;
  /** The path after `/<provider>`, with its query: what the real provider would see. */
  path: string;
  /** Request headers, lower-cased, with credentials replaced by `[redacted]`. */
  headers: Record<string, string>;
  /** JSON or form bodies parsed; anything else as text; null when empty. */
  body: unknown;
  /** When the stub received it (ISO). */
  at: string;
}

interface Failure {
  provider: StubProvider;
  status?: number;
  body?: unknown;
  timeout?: boolean;
  times?: number;
  match?: string;
}

interface Answer {
  provider: StubProvider;
  method?: string;
  path: string;
  status?: number;
  body: unknown;
}

const REDACTED_HEADERS = new Set(['authorization', 'api-key', 'apikey', 'x-api-key', 'cookie', 'proxy-authorization']);

const id = (prefix: string, bytes = 8) => `${prefix}${randomBytes(bytes).toString('hex')}`;

function parseBody(raw: string, contentType: string | undefined): unknown {
  if (!raw) return null;
  if (contentType?.includes('application/x-www-form-urlencoded')) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/** Each provider's documented answer to a successful request, by method and path. */
function successFor(provider: StubProvider, method: string, path: string, body: Record<string, unknown>): [number, unknown] {
  const p = path.split('?')[0];
  switch (provider) {
    case 'platform-brevo':
    case 'brevo':
      if (method === 'POST' && p === '/v3/smtp/email') return [201, { messageId: `<${id('')}@smtp-relay.mailin.fr>` }];
      if (method === 'GET' && p === '/v3/account') {
        return [200, { email: 'owner@e2e.example.test', firstName: 'E2E', lastName: 'Stub', companyName: 'E2E Stub', plan: [{ type: 'free', credits: 300, creditsType: 'sendLimit' }] }];
      }
      break;
    case 'resend':
      if (method === 'POST' && p === '/emails') return [200, { id: randomUUID() }];
      if (method === 'GET' && p === '/domains') return [200, { object: 'list', data: [] }];
      break;
    case 'twilio': {
      const account = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\.json$/.exec(p);
      if (method === 'GET' && account) {
        return [200, { sid: account[1], friendly_name: 'E2E stub account', status: 'active', type: 'Full' }];
      }
      const messages = /^\/2010-04-01\/Accounts\/(AC[0-9a-fA-F]{32})\/Messages\.json$/.exec(p);
      if (method === 'POST' && messages) {
        return [
          201,
          {
            sid: id('SM', 16),
            account_sid: messages[1],
            to: body.To,
            from: body.From ?? null,
            messaging_service_sid: body.MessagingServiceSid ?? null,
            body: body.Body ?? null,
            status: 'queued',
            num_segments: '1',
            error_code: null,
            error_message: null,
            date_created: new Date().toUTCString(),
          },
        ];
      }
      break;
    }
    case 'twilio-content':
      if (method === 'GET' && p === '/v1/ContentAndApprovals') {
        return [200, { contents: [], meta: { page: 0, page_size: 500, first_page_url: null, previous_page_url: null, next_page_url: null, key: 'contents' } }];
      }
      break;
    case 'meta': {
      if (method === 'POST' && /^\/v\d+\.\d+\/\d+\/messages$/.test(p)) {
        return [200, { messaging_product: 'whatsapp', contacts: [{ input: body.to, wa_id: body.to }], messages: [{ id: `wamid.${id('', 16)}` }] }];
      }
      if (method === 'GET' && /^\/v\d+\.\d+\/\d+\/message_templates$/.test(p)) return [200, { data: [], paging: {} }];
      const number = /^\/v\d+\.\d+\/(\d+)$/.exec(p);
      if (method === 'GET' && number) {
        return [200, { id: number[1], display_phone_number: '+1 555-0100', verified_name: 'E2E Stub' }];
      }
      break;
    }
    case 'gupshup':
      if (method === 'POST' && p === '/wa/api/v1/template/msg') return [202, { status: 'submitted', messageId: randomUUID() }];
      if (method === 'GET' && /^\/wa\/app\/[^/]+\/template$/.test(p)) return [200, { status: 'success', templates: [] }];
      break;
    case 'interakt':
      if (method === 'POST' && p === '/v1/public/message/') {
        return [201, { result: true, message: 'Message created successfully', id: randomUUID() }];
      }
      if (method === 'POST' && p === '/v1/public/apis/users/') {
        return [200, { result: true, message: 'Customers found', data: { total_customers: 0, customers: [] } }];
      }
      break;
    case 'mixpanel':
      if (method === 'GET' && p === '/api/2.0/cohorts/list') return [200, []];
      if (method === 'POST' && p === '/api/2.0/engage') {
        return [200, { page: 0, page_size: 1000, session_id: id(''), status: 'ok', total: 0, results: [] }];
      }
      break;
    case 'fcm': {
      const send = /^\/v1\/projects\/([^/]+)\/messages:send$/.exec(p);
      if (method === 'POST' && send) return [200, { name: `projects/${send[1]}/messages/${Date.now()}${randomBytes(2).readUInt16BE()}` }];
      break;
    }
    case 'google-oauth':
      if (method === 'POST' && p === '/token') return [200, { access_token: `ya29.${id('', 24)}`, expires_in: 3599, token_type: 'Bearer' }];
      break;
  }
  return [404, { message: `The provider stub has no route for ${provider} ${method} ${p}` }];
}

/** An error body in the provider's own shape, for injected failures. */
function errorFor(provider: StubProvider, status: number): unknown {
  switch (provider) {
    case 'platform-brevo':
    case 'brevo':
      return { code: status === 401 ? 'unauthorized' : 'bad_request', message: `Stubbed failure (${status})` };
    case 'resend':
      return { statusCode: status, name: status === 401 ? 'validation_error' : 'application_error', message: `Stubbed failure (${status})` };
    case 'twilio':
    case 'twilio-content':
      return { code: status === 401 ? 20003 : 20500, message: `Stubbed failure (${status})`, more_info: 'https://www.twilio.com/docs/errors', status };
    case 'meta':
      return { error: { message: `Stubbed failure (${status})`, type: 'OAuthException', code: status === 401 ? 190 : 1 } };
    case 'gupshup':
      return { status: 'error', message: `Stubbed failure (${status})` };
    case 'interakt':
      return { result: false, message: `Stubbed failure (${status})` };
    case 'mixpanel':
      return { error: `Stubbed failure (${status})`, status: 'error' };
    case 'fcm':
      return { error: { code: status, message: `Stubbed failure (${status})`, status: status === 404 ? 'NOT_FOUND' : 'INTERNAL' } };
    case 'google-oauth':
      return { error: status === 400 ? 'invalid_grant' : 'internal_failure', error_description: `Stubbed failure (${status})` };
  }
}

export interface ProviderStub {
  url: string;
  close(): Promise<void>;
}

export async function startProviderStub(port: number): Promise<ProviderStub> {
  const calls: StubCall[] = [];
  let failures: Failure[] = [];
  let answers: Answer[] = [];
  const sockets = new Set<Socket>();

  const isProvider = (value: unknown): value is StubProvider => STUB_PROVIDERS.includes(value as StubProvider);

  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk: string) => (raw += chunk));
    req.on('end', () => {
      const send = (status: number, body: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const url = new URL(req.url ?? '/', 'http://stub');
      const method = req.method ?? 'GET';

      // Test controls.
      if (url.pathname.startsWith('/__stub/')) {
        let control: Record<string, unknown> = {};
        try {
          control = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          return send(400, { message: 'invalid JSON' });
        }
        const provider = control.provider ?? undefined;
        if (provider !== undefined && !isProvider(provider)) return send(400, { message: `unknown provider ${String(provider)}` });
        if (url.pathname === '/__stub/calls' && method === 'GET') {
          const only = url.searchParams.get('provider');
          if (only !== null && !isProvider(only)) return send(400, { message: `unknown provider ${only}` });
          return send(200, only ? calls.filter((call) => call.provider === only) : calls);
        }
        if (url.pathname === '/__stub/reset' && method === 'POST') {
          const keep = (entry: { provider: StubProvider }) => provider !== undefined && entry.provider !== provider;
          const kept = calls.filter(keep);
          calls.length = 0;
          calls.push(...kept);
          failures = failures.filter(keep);
          answers = answers.filter(keep);
          return send(200, { reset: provider ?? 'all' });
        }
        if (url.pathname === '/__stub/fail' && method === 'POST') {
          if (!provider) return send(400, { message: 'provider is required' });
          if (control.timeout !== true && typeof control.status !== 'number') return send(400, { message: 'status or timeout is required' });
          failures.push(control as unknown as Failure);
          return send(200, control);
        }
        if (url.pathname === '/__stub/answer' && method === 'POST') {
          if (!provider || typeof control.path !== 'string') return send(400, { message: 'provider and path are required' });
          answers.unshift(control as unknown as Answer);
          return send(200, control);
        }
        return send(404, { message: 'no such control' });
      }

      const [, first, ...rest] = url.pathname.split('/');
      if (!isProvider(first)) return send(404, { message: `The provider stub has no provider ${first}` });
      const provider = first;
      const path = `/${rest.join('/')}${url.search}`;
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        headers[name] = REDACTED_HEADERS.has(name) ? '[redacted]' : Array.isArray(value) ? value.join(', ') : value;
      }
      const body = parseBody(raw, req.headers['content-type']);
      calls.push({ provider, method, path, headers, body, at: new Date().toISOString() });

      const failure = failures.find(
        (f) => f.provider === provider && (f.match === undefined || path.includes(f.match) || raw.includes(f.match)),
      );
      if (failure) {
        if (failure.times !== undefined && --failure.times <= 0) failures = failures.filter((f) => f !== failure);
        if (failure.timeout) return; // Never answered; the caller's own time limit ends it.
        return send(failure.status as number, failure.body ?? errorFor(provider, failure.status as number));
      }

      const answer = answers.find(
        (a) => a.provider === provider && (a.method === undefined || a.method === method) && path.startsWith(a.path),
      );
      if (answer) return send(answer.status ?? 200, answer.body);

      const [status, answerBody] = successFor(provider, method, path, (body ?? {}) as Record<string, unknown>);
      return send(status, answerBody);
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve) => {
        // Requests held by a `timeout` failure would otherwise keep the server open.
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

// ------------------------------------------------------- for the tests ---

function stubUrl(path: string): string {
  const base = process.env.E2E_PROVIDER_STUB_URL;
  if (!base) throw new Error('E2E_PROVIDER_STUB_URL is not set: run the specs through playwright.config.ts');
  return `${base}${path}`;
}

async function control<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(stubUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Provider stub ${method} ${path} answered ${response.status}: ${text}`);
  return JSON.parse(text) as T;
}

/** The calls the stub recorded for `provider`, oldest first. */
export function stubCalls(provider: StubProvider): Promise<StubCall[]> {
  return control('GET', `/__stub/calls?provider=${provider}`);
}

/** Forgets the calls, failures and answers of `provider`. Other tests share the stub: prefer filtering. */
export async function resetStub(provider: StubProvider): Promise<void> {
  await control('POST', '/__stub/reset', { provider });
}

export interface StubFailure {
  status?: number;
  body?: unknown;
  timeout?: boolean;
  times?: number;
  /** Only requests whose path or body contains this (a test's own address or account id). */
  match?: string;
}

/** Makes `provider` fail (see the controls above). Give `match` so other tests are not affected. */
export async function failStub(provider: StubProvider, failure: StubFailure): Promise<void> {
  await control('POST', '/__stub/fail', { provider, ...failure });
}

/** Answers requests to `provider` whose path starts with `path` with `body`, until reset. */
export async function answerStub(provider: StubProvider, answer: { method?: string; path: string; status?: number; body: unknown }): Promise<void> {
  await control('POST', '/__stub/answer', { provider, ...answer });
}
