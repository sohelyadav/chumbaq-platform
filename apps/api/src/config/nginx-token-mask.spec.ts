import { spawnSync } from 'child_process';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';

/**
 * Fail-closed: every API route with a secret in its path (a parameter named like a
 * token, secret, signature or key) must be masked by the nginx log format's path map
 * (scripts/server-security.sh), or 180 days of access logs would keep the secret.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/server-security.sh');
const MODULES = path.resolve(__dirname, '../modules');
const SECRET_PARAM = /:([A-Za-z]*(token|secret|signature|key)[A-Za-z]*)/i;
const SAMPLE = 'S3CR3TS3CR3TS3CR3T';

/** `[pattern, replacement]` from the `map $uri $chumbaq_log_path` block, as JavaScript. */
function nginxMasks(): [RegExp, string][] {
  const conf = spawnSync('bash', ['-c', 'source "$SCRIPT"; nginx_logging_conf'], {
    env: { PATH: process.env.PATH, SCRIPT },
    encoding: 'utf8',
  }).stdout;
  const block = conf.slice(conf.indexOf('map $uri $chumbaq_log_path'), conf.indexOf('}', conf.indexOf('map $uri')));
  return [...block.matchAll(/^\s*~(\S+)\s+(\S+);$/gm)].map(([, re, to]) => [new RegExp(re), to]);
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith('.controller.ts') ? [path.join(dir, e.name)] : [],
  );
}

/** `/api/<controller prefix>/<route>` for every decorated route in the source. */
export function routesOf(source: string): string[] {
  const prefix = /@Controller\(\s*['"`]([^'"`]*)['"`]/.exec(source)?.[1] ?? '';
  return [...source.matchAll(/@(?:Get|Post|Put|Patch|Delete|All)\(\s*['"`]([^'"`]*)['"`]/g)].map(
    ([, route]) => `/api/${[prefix, route].filter(Boolean).join('/')}`.replace(/\/+/g, '/'),
  );
}

export function unmasked(routes: string[], masks: [RegExp, string][]): string[] {
  return routes
    .filter((r) => SECRET_PARAM.test(r))
    .map((r) => r.replace(/:[A-Za-z]+/g, (p) => (SECRET_PARAM.test(p) ? SAMPLE : 'x')))
    .filter((p) => {
      const logged = masks.reduce((acc, [re, to]) => (re.test(acc) ? acc.replace(re, to) : acc), p);
      return logged.includes(SAMPLE);
    });
}

describe('nginx access log path masks', () => {
  const masks = nginxMasks();
  const routes = walk(MODULES).flatMap((f) => routesOf(readFileSync(f, 'utf8')));

  it('reads real routes and masks', () => {
    expect(masks.length).toBeGreaterThan(0);
    expect(routes.filter((r) => SECRET_PARAM.test(r)).length).toBeGreaterThanOrEqual(7);
  });

  it('masks the secret in every route that has one in its path', () => {
    expect(unmasked(routes, masks)).toEqual([]);
  });

  it('would catch a new unmasked one', () => {
    expect(unmasked(['/api/billing/webhooks/stripe/:signingSecret'], masks)).toEqual([
      `/api/billing/webhooks/stripe/${SAMPLE}`,
    ]);
  });
});
