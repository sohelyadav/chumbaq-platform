import { execFileSync } from 'child_process';
import { parse as parseDotenv } from 'dotenv';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * scripts/deploy-setup.sh writes the admin API's ADMIN_APP_URL and the web build's
 * VITE_ADMIN_APP_URL, so it decides whether staff passkeys and the view-as redirect
 * work in production. Here because apps/api is the only workspace with a test runner.
 * The script stops after its function definitions when sourced, so these run the real
 * functions without apt, sudo or nginx.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/deploy-setup.sh');

function run(body: string, env: Record<string, string> = {}): string {
  // A sudo that refuses, defined before sourcing: if the source guard ever broke, the
  // script's apt, nginx and pm2 steps would fail here instead of running.
  const refuseSudo = 'sudo() { echo "sudo refused in tests" >&2; return 1; }\n';
  return execFileSync('bash', ['-c', `${refuseSudo}source "$SCRIPT"\n${body}`], {
    env: { PATH: process.env.PATH, SCRIPT, ...env },
    encoding: 'utf8',
  });
}

/**
 * Runs the whole script (not sourced) in `root`, with stub sudo, npm and pm2 first on the
 * PATH, each logging what it was asked to do. The stub sudo runs only the file commands
 * the nginx steps use (sh for the TLS check, grep, tee, ln, rm), on the scratch nginx
 * directories; apt, systemctl, nginx, psql and the rest are logged and succeed. Any read
 * of the file named by `failRead` fails the way a refused sudo does.
 */
function runWholeScript(
  root: string,
  opts: { env: string; failRead?: string; sites?: Record<string, string>; vars?: Record<string, string> },
) {
  const app = path.join(root, 'app');
  const sites = path.join(root, 'sites-available');
  const enabled = path.join(root, 'sites-enabled');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'log');
  for (const d of [app, sites, enabled, bin]) mkdirSync(d, { recursive: true });
  writeFileSync(path.join(app, '.env'), opts.env);
  for (const [name, contents] of Object.entries(opts.sites ?? {})) writeFileSync(path.join(sites, name), contents);
  writeFileSync(log, '');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  stub(
    'sudo',
    [
      'printf "sudo %s\\n" "$*" >> "$STUB_LOG"',
      'case $1 in',
      '  sh) if [ -n "$STUB_FAIL_READ" ] && [ "${@: -1}" = "$STUB_FAIL_READ" ]; then exit 1; fi; exec "$@" ;;',
      '  grep|tee|ln|rm|mkdir|chmod|mv) exec "$@" ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n'),
  );
  stub('npm', 'printf "npm %s\\n" "$*" >> "$STUB_LOG"');
  // Logs the PM2_PREFIX it was run with, which names the ecosystem file's processes.
  stub('pm2', 'printf "%spm2 %s\\n" "${PM2_PREFIX:+PM2_PREFIX=$PM2_PREFIX }" "$*" >> "$STUB_LOG"');
  // A synced clock, as chrony answers once it has a source.
  stub('chronyc', 'printf "chronyc %s\\n" "$*" >> "$STUB_LOG"; echo "A4FFFF7A,samay1.nic.in,2,1794236500.1,0.000012,0,0,0,0,0,0,0,64,Normal"');
  stub('git', 'printf "git %s\\n" "$*" >> "$STUB_LOG"');
  stub('curl', 'printf "curl %s\\n" "$*" >> "$STUB_LOG"');
  let ok = true;
  let out: string;
  try {
    out = execFileSync('bash', [SCRIPT], {
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        APP_DIR: app,
        NGINX_SITES: sites,
        NGINX_ENABLED: enabled,
        ADMIN_SERVER_NAME: 'admin.example.com',
        APP_SERVER_NAME: 'app.example.com',
        REPO_URL: 'git@example.com:chumbaq-platform.git',
        STUB_LOG: log,
        STUB_FAIL_READ: opts.failRead ?? '',
        // The CERT-In server pieces write under here instead of /etc, /usr/local and /var.
        SYSTEM_ROOT: path.join(root, 'system'),
        ...opts.vars,
      },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const e = error as { stdout: string; stderr: string };
    ok = false;
    out = `${e.stdout}${e.stderr}`;
  }
  return { ok, out, log: readFileSync(log, 'utf8'), app, sites, enabled, system: path.join(root, 'system') };
}

describe('scripts/deploy-setup.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'deploy-setup-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  describe('the .env template', () => {
    it('points both admin URLs at ADMIN_SERVER_NAME', () => {
      const file = path.join(dir, 'env');
      run(`write_env_template "${file}"`, { ADMIN_SERVER_NAME: 'admin.example.com' });
      const written = readFileSync(file, 'utf8');
      expect(written).toMatch(/^ADMIN_APP_URL=https:\/\/admin\.example\.com$/m);
      expect(written).toMatch(/^VITE_ADMIN_APP_URL=https:\/\/admin\.example\.com$/m);
      expect(written).not.toContain('admin.chumbaq.com');
      // The rest is still written literally.
      expect(written).toMatch(/^JWT_EXPIRATION=15m$/m);
      expect(written).toMatch(/^GEOIP_ENABLED=true$/m);
    });

    it('defaults to admin.chumbaq.com', () => {
      const file = path.join(dir, 'env');
      run(`write_env_template "${file}"`);
      expect(readFileSync(file, 'utf8')).toMatch(/^VITE_ADMIN_APP_URL=https:\/\/admin\.chumbaq\.com$/m);
    });

    // Every variable the API, admin API and worker refuse to start without, with real
    // secrets: a template that boots nothing, or boots with a placeholder secret, is the
    // failure this guards against.
    it('writes everything the API needs to start, with generated secrets', () => {
      const file = path.join(dir, 'env');
      run(`write_env_template "${file}"`, { REDIS_PASSWORD: 'r'.repeat(20) });
      const env = parseDotenv(readFileSync(file, 'utf8'));
      for (const key of [
        'DATABASE_HOST', 'DATABASE_PORT', 'DATABASE_USER', 'DATABASE_PASSWORD', 'DATABASE_NAME',
        'REDIS_HOST', 'REDIS_PORT', 'API_PORT', 'APP_URL', 'API_BASE_URL', 'CORS_ORIGINS',
        'SHORT_LINK_DOMAIN', 'JWT_SECRET', 'JWT_REFRESH_SECRET', 'MFA_ENCRYPTION_KEY',
        'CREDENTIALS_ENCRYPTION_KEY', 'ADMIN_API_PORT', 'ADMIN_APP_URL', 'VITE_ADMIN_APP_URL',
      ]) {
        expect([key, env[key] ?? '']).toEqual([key, expect.stringMatching(/./)]);
      }
      expect(readFileSync(file, 'utf8')).not.toMatch(/CHANGE_ME|YOUR_/);
      expect(env.APP_URL).toBe('https://app.chumbaq.com');
      expect(env.CORS_ORIGINS).toBe('https://app.chumbaq.com');
      expect(env.REDIS_PASSWORD).toBe('r'.repeat(20));
      expect(env.JWT_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
      expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(64);
      expect(env.DATABASE_PASSWORD).toMatch(/^[0-9a-f]{48}$/);
      expect(env.CREDENTIALS_ENCRYPTION_KEY).toMatch(/^[0-9a-f]{64}$/);
      expect(Buffer.from(env.MFA_ENCRYPTION_KEY, 'base64')).toHaveLength(32);
      expect(lstatSync(file).mode & 0o777).toBe(0o600);
      // A second template gets its own secrets.
      const other = path.join(dir, 'other');
      run(`write_env_template "${other}"`);
      expect(parseDotenv(readFileSync(other, 'utf8')).JWT_SECRET).not.toBe(env.JWT_SECRET);
    });

    it('gives stage its own hosts, ports, database and Redis DB', () => {
      const file = path.join(dir, 'env');
      run(`write_env_template "${file}"`, { DEPLOY_ENV: 'stage' });
      const env = parseDotenv(readFileSync(file, 'utf8'));
      expect(env).toMatchObject({
        APP_URL: 'https://stage.chumbaq.com',
        ADMIN_APP_URL: 'https://admin-stage.chumbaq.com',
        VITE_ADMIN_APP_URL: 'https://admin-stage.chumbaq.com',
        API_PORT: '3100',
        ADMIN_API_PORT: '3111',
        DATABASE_NAME: 'chumbaq_stage',
        DATABASE_USER: 'chumbaq_stage',
        REDIS_DB: '1',
      });
      run(`write_env_template "${file}"`);
      expect(parseDotenv(readFileSync(file, 'utf8'))).toMatchObject({ API_PORT: '3000', REDIS_DB: '0' });
    });

    it('refuses any DEPLOY_ENV but prod and stage', () => {
      expect(() => run('true 2>/dev/null', { DEPLOY_ENV: 'production' })).toThrow();
      expect(() => run('true', { DEPLOY_ENV: 'stage' })).not.toThrow();
    });

    it('refuses the same host for the dashboard and the admin app', () => {
      expect(() =>
        run('check_server_names 2>/dev/null', { APP_SERVER_NAME: 'Admin.example.com', ADMIN_SERVER_NAME: 'admin.example.com' }),
      ).toThrow();
      expect(() => run('check_server_names 2>/dev/null', { APP_SERVER_NAME: 'app.example.com;' })).toThrow();
      expect(() => run('check_server_names', { APP_SERVER_NAME: 'app.example.com', ADMIN_SERVER_NAME: 'admin.example.com' })).not.toThrow();
    });

    it('reads the database settings dotenv reads, and refuses ones unsafe in SQL', () => {
      const read = (contents: string) => {
        const file = path.join(dir, 'env');
        writeFileSync(file, contents);
        return run(`read_database_settings "${file}" 2>/dev/null && echo "$DB_USER $DB_NAME $DB_PASSWORD"`).trim();
      };
      const good = 'DATABASE_USER=chumbaq\nDATABASE_NAME=chumbaq\nDATABASE_PASSWORD=0123456789abcdef0123\n';
      expect(read(good)).toBe('chumbaq chumbaq 0123456789abcdef0123');
      // dotenv takes the last line.
      expect(read(good + 'DATABASE_NAME=chumbaq_two\n')).toBe('chumbaq chumbaq_two 0123456789abcdef0123');
      for (const bad of [
        good.replace('DATABASE_USER=chumbaq', 'DATABASE_USER=chumbaq;drop'),
        good.replace('DATABASE_NAME=chumbaq', 'DATABASE_NAME=Chumbaq'),
        good.replace('0123456789abcdef0123', "abc'def0123456789abcdef"),
        good.replace('0123456789abcdef0123', 'short'),
        'DATABASE_NAME=chumbaq\n',
      ]) {
        expect(() => read(bad)).toThrow();
      }
    });

    describe('an existing .env', () => {
      const ensure = (contents: string, name = 'admin.example.com') => {
        const file = path.join(dir, 'env');
        writeFileSync(file, contents);
        try {
          const out = execFileSync('bash', ['-c', `source "$SCRIPT"\nensure_admin_app_urls "${file}"`], {
            env: { PATH: process.env.PATH, SCRIPT, ADMIN_SERVER_NAME: name },
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          return { ok: true, out, written: readFileSync(file, 'utf8') };
        } catch (error) {
          const e = error as { stdout: string; stderr: string };
          return { ok: false, out: `${e.stdout}${e.stderr}`, written: readFileSync(file, 'utf8') };
        }
      };

      it('leaves both URLs alone when they are already on ADMIN_SERVER_NAME', () => {
        const env = 'ADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL="https://Admin.example.com/"\n';
        const result = ensure(env);
        expect(result.ok).toBe(true);
        expect(result.written).toBe(env);
      });

      it('adds whichever URL is missing, on ADMIN_SERVER_NAME', () => {
        expect(ensure('API_PORT=3000\n').written).toBe(
          'API_PORT=3000\nADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n',
        );
        expect(ensure('ADMIN_APP_URL=https://admin.example.com\n').written).toBe(
          'ADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n',
        );
        expect(ensure('VITE_ADMIN_APP_URL=https://admin.example.com\n').written).toBe(
          'VITE_ADMIN_APP_URL=https://admin.example.com\nADMIN_APP_URL=https://admin.example.com\n',
        );
      });

      // A new host for the admin app is a new relying party: every staff passkey stops
      // working. So it is never made quietly, by this script or by its default name.
      it.each([
        ['ADMIN_APP_URL', 'ADMIN_APP_URL=https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        ['VITE_ADMIN_APP_URL', 'ADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.old.com\n'],
        ['both', 'ADMIN_APP_URL=https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.old.com\n'],
        ['a missing one added beside a mismatched one', 'ADMIN_APP_URL=https://admin.old.com\n'],
        ['an empty one', 'ADMIN_APP_URL=\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        // dotenv (the API's and Vite's reader) also takes these as setting the name, so
        // calling them missing would append a new-host line that dotenv then prefers.
        ['an export line', 'export ADMIN_APP_URL=https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        ['an indented line', '  ADMIN_APP_URL=https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        ['spaces around =', 'ADMIN_APP_URL = https://admin.old.com\n\tVITE_ADMIN_APP_URL\t=\thttps://admin.old.com\n'],
        ['a colon', 'ADMIN_APP_URL: https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        // new URL() reads the host after the user info: admin.old.com.
        [
          'user info naming the new host',
          'ADMIN_APP_URL=https://admin.example.com:x@admin.old.com/\nVITE_ADMIN_APP_URL=https://admin.example.com\n',
        ],
        ['a backslash before the new host', 'ADMIN_APP_URL=https://admin.old.com\\@admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        // dotenv takes the last line, so a matching first line proves nothing.
        [
          'a later duplicate',
          'ADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\nADMIN_APP_URL=https://admin.old.com\n',
        ],
        [
          'an earlier duplicate',
          'ADMIN_APP_URL=https://admin.old.com\nADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n',
        ],
      ])('stops on a host that differs (%s), changing nothing', (_case, env) => {
        const result = ensure(env);
        expect(result.ok).toBe(false);
        expect(result.written).toBe(env);
        expect(result.out).toContain('admin.example.com');
        expect(result.out).toMatch(/passkey/i);
        expect(result.out).toContain('ADMIN_SERVER_NAME=');
      });

      it.each([
        ['export lines', 'export ADMIN_APP_URL=https://admin.example.com\nexport VITE_ADMIN_APP_URL=https://admin.example.com\n'],
        ['spaces and a comment', '  ADMIN_APP_URL = https://admin.example.com # staff\nVITE_ADMIN_APP_URL="https://admin.example.com" # web\n'],
        ['a backtick quote and CRLF', 'ADMIN_APP_URL=`https://admin.example.com`\r\nVITE_ADMIN_APP_URL=https://admin.example.com\r\n'],
        ['a commented-out old host', '# ADMIN_APP_URL=https://admin.old.com\nADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
        ['a longer name that only starts the same', 'ADMIN_APP_URL_OLD=https://admin.old.com\nADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n'],
      ])('accepts and leaves alone a matching .env with %s', (_case, env) => {
        const result = ensure(env);
        expect(result.ok).toBe(true);
        expect(result.written).toBe(env);
      });

      it('counts an export or indented line as present, adding only what dotenv does not see', () => {
        const env = 'export ADMIN_APP_URL=https://admin.example.com\n';
        expect(ensure(env).written).toBe(`${env}VITE_ADMIN_APP_URL=https://admin.example.com\n`);
      });

      // The point of the check is what the API and the web build will read, so hold it
      // against dotenv itself: whenever the script lets a run go on, dotenv's values for
      // both names are on ADMIN_SERVER_NAME.
      it('never goes on when dotenv would read another host', () => {
        const lines = [
          'ADMIN_APP_URL=https://admin.example.com',
          'ADMIN_APP_URL=https://admin.old.com',
          'export ADMIN_APP_URL=https://admin.old.com',
          '  ADMIN_APP_URL = https://admin.old.com',
          'ADMIN_APP_URL: https://admin.old.com',
          'ADMIN_APP_URL="https://admin.old.com"',
          'ADMIN_APP_URL=https://admin.example.com:x@admin.old.com/',
          'ADMIN_APP_URL=https://admin.old.com?x@admin.example.com',
          'VITE_ADMIN_APP_URL=https://admin.example.com',
          'VITE_ADMIN_APP_URL=https://admin.example.com@admin.old.com',
          'export VITE_ADMIN_APP_URL=https://admin.old.com',
          '\tVITE_ADMIN_APP_URL=https://admin.old.com',
        ];
        for (let a = 0; a < lines.length; a += 1) {
          for (let b = 0; b < lines.length; b += 1) {
            const env = `${lines[a]}\n${lines[b]}\n`;
            const result = ensure(env);
            if (!result.ok) continue;
            const read = parseDotenv(result.written);
            // The host as the API (RP ID) and the web build read it.
            expect([env, new URL(read.ADMIN_APP_URL).hostname]).toEqual([env, 'admin.example.com']);
            expect([env, new URL(read.VITE_ADMIN_APP_URL).hostname]).toEqual([env, 'admin.example.com']);
          }
        }
      });

      // The whole script, run for real with stubs: a refusal that the main flow ignored
      // (`|| true`, `&& echo ok`, an if around it) would still pass any test of where the
      // call sits.
      it('stops the whole script before the build and nginx', () => {
        const env = 'ADMIN_APP_URL=https://admin.old.com\nVITE_ADMIN_APP_URL=https://admin.old.com\n';
        const result = runWholeScript(dir, { env });
        expect(result.ok).toBe(false);
        expect(result.out).toMatch(/passkey/i);
        expect(readFileSync(path.join(result.app, '.env'), 'utf8')).toBe(env);
        expect(result.log).not.toMatch(/^npm /m);
        expect(result.log).not.toMatch(/nginx -t|systemctl restart nginx|^sudo (tee|ln) .*sites-/m);
        expect(existsSync(path.join(result.sites, 'chumbaq'))).toBe(false);
        expect(existsSync(path.join(result.sites, 'chumbaq-admin'))).toBe(false);
      });
    });

    describe('url_host', () => {
      const hosts = (values: string[]): string[] =>
        execFileSync(
          'bash',
          ['-c', 'source "$SCRIPT"\nfor v in "$@"; do printf "%s\\0" "$(url_host "$v")"; done', 'bash', ...values],
          { env: { PATH: process.env.PATH, SCRIPT }, encoding: 'utf8' },
        )
          .split('\0')
          .slice(0, values.length);

      it('reads the host that new URL() reads, or nothing', () => {
        const values = [
          'https://admin.example.com',
          'HTTPS://Admin.Example.com:443/path?q#f',
          'https://admin.example.com:x@admin.old.com/',
          'https://user:pw@admin.example.com/',
          'https://a@b@admin.example.com',
          'https://admin.old.com?x@admin.example.com',
          'https://admin.old.com#@admin.example.com',
          'https://admin.old.com\\@admin.example.com',
          'https://admin.old.com/@admin.example.com',
          'http://admin.example.com',
          'foo://admin.old.com\\@admin.example.com',
          'https:admin.example.com',
          'admin.example.com',
          '"https://admin.example.com/"',
        ];
        const got = hosts(values);
        values.forEach((value, i) => {
          if (got[i] === '') return;
          // Never a host the API or the web build would not also read.
          expect([value, got[i]]).toEqual([value, new URL(value.replace(/^"|"$/g, '')).hostname]);
        });
        // And the plain cases still give a host, so the check above is not vacuous.
        expect(got.slice(0, 5)).toEqual([
          'admin.example.com',
          'admin.example.com',
          'admin.old.com',
          'admin.example.com',
          'admin.example.com',
        ]);
        expect(got[10]).toBe('');
      });
    });

    it('refuses a server name that is not a host name before writing anything', () => {
      for (const name of [
        'admin.example.com;',
        'a b',
        '$(id)',
        // One valid line is not enough: the second would land in the .env as its own line.
        'admin.example.com\nSTAFF_WEBAUTHN_RP_ID=evil.test',
        'a.com;\nx',
        '-x',
        '.example.com',
      ]) {
        expect(() => run('check_admin_server_name 2>/dev/null', { ADMIN_SERVER_NAME: name })).toThrow();
      }
      expect(() => run('check_admin_server_name', { ADMIN_SERVER_NAME: 'admin.example.com' })).not.toThrow();
      expect(() => run('check_admin_server_name', { ADMIN_SERVER_NAME: 'Admin-1.example.com' })).not.toThrow();
    });

    // apps/web bakes VITE_ADMIN_APP_URL in and refuses a production build without it, so
    // the .env has to exist (and carry it) before the build step runs.
    it('writes the .env before it builds the dashboard', () => {
      const script = readFileSync(SCRIPT, 'utf8');
      const main = script.slice(script.indexOf('# Sourced by the tests'));
      const writeEnv = main.indexOf('write_env_template "$APP_DIR/.env"');
      const ensureEnv = main.indexOf('ensure_admin_app_urls "$APP_DIR/.env"');
      const buildWeb = main.indexOf('npm run build:web\n');
      expect(writeEnv).toBeGreaterThan(-1);
      expect(ensureEnv).toBeGreaterThan(-1);
      expect(buildWeb).toBeGreaterThan(-1);
      expect(writeEnv).toBeLessThan(buildWeb);
      expect(ensureEnv).toBeLessThan(buildWeb);
      // Also before any build at all, so no step can bake a stale value in first.
      expect(writeEnv).toBeLessThan(main.indexOf('npm run build:'));
    });
  });

  describe('nginx sites', () => {
    const shim = 'sudo() { "$@"; }\n';

    it('writes the admin site for the server name, with the allow-list', () => {
      const out = run('admin_site_config', {
        ADMIN_SERVER_NAME: 'admin.example.com',
        ADMIN_ALLOWED_IPS: '203.0.113.7, 198.51.100.0/24',
      });
      expect(out).toContain('server_name admin.example.com;');
      expect(out).toContain('allow 203.0.113.7;');
      expect(out).toContain('allow 198.51.100.0/24;');
      expect(out).toContain('deny all;');
    });

    it('serves the dashboard and proxies the API, short links and app-link files on its host', () => {
      const out = run('customer_site_config', { APP_SERVER_NAME: 'app.example.com', APP_DIR: '/srv/chumbaq' });
      expect(out).toContain('server_name app.example.com;');
      expect(out).not.toContain('default_server');
      expect(out).toContain('root /srv/chumbaq/apps/web/dist;');
      const proxied = { '/api/': 'http://127.0.0.1:3000;', '/.well-known/': 'http://127.0.0.1:3000;', '/redirect/': 'http://127.0.0.1:3000/api/;' };
      for (const [location, target] of Object.entries(proxied)) {
        const block = out.slice(out.indexOf(`location ${location} {`));
        expect([location, block.slice(0, block.indexOf('}'))]).toEqual([
          location,
          expect.stringContaining(`proxy_pass ${target}`),
        ]);
      }
      expect(out).not.toMatch(/__[A-Z_]+__/);
      const stage = run('customer_site_config', { DEPLOY_ENV: 'stage' });
      expect(stage).toContain('server_name stage.chumbaq.com;');
      expect(stage).toContain('root /home/ubuntu/chumbaq-stage/apps/web/dist;');
      expect(stage).toContain('proxy_pass http://127.0.0.1:3100;');
      expect(stage).not.toContain('127.0.0.1:3000');
    });

    it("points the admin site at its environment's admin API and build", () => {
      const out = run('admin_site_config', { DEPLOY_ENV: 'stage' });
      expect(out).toContain('server_name admin-stage.chumbaq.com;');
      expect(out).toContain('root /home/ubuntu/chumbaq-stage/apps/admin/dist;');
      expect(out).toContain('proxy_pass http://127.0.0.1:3111;');
      expect(out).not.toMatch(/__[A-Z_]+__/);
    });

    it('refuses an APP_DIR it would have to escape in an nginx root line', () => {
      for (const bad of ['relative/dir', '/srv/a b', '/srv/x;include /etc/passwd', '/srv/a|b']) {
        expect(() => run('customer_site_config 2>/dev/null', { APP_DIR: bad })).toThrow();
      }
    });

    it('sees TLS that certbot added', () => {
      const managed = path.join(dir, 'managed');
      writeFileSync(managed, 'server {\n    listen 443 ssl; # managed by Certbot\n}\n');
      const manual = path.join(dir, 'manual');
      writeFileSync(manual, 'server {\n    listen 443 ssl;\n    ssl_certificate /x.pem;\n}\n');
      const plain = path.join(dir, 'plain');
      writeFileSync(plain, 'server {\n    listen 80;\n}\n');
      const has = (file: string) => run(`${shim}has_tls_config "${file}" && echo yes || echo no`).trim();
      expect(has(managed)).toBe('yes');
      expect(has(manual)).toBe('yes');
      expect(has(plain)).toBe('no');
      expect(has(path.join(dir, 'missing'))).toBe('no');
    });

    it('leaves a site certbot manages as it is on a second run', () => {
      const file = path.join(dir, 'chumbaq-admin');
      const certbot = 'server {\n    listen 443 ssl; # managed by Certbot\n    server_name admin.example.com;\n}\n';
      writeFileSync(file, certbot);
      const out = run(`${shim}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'admin.example.com',
      });
      expect(readFileSync(file, 'utf8')).toBe(certbot);
      expect(out).toContain('left as it is');
    });

    it('writes a site that has no TLS yet, and rewrites a plain one', () => {
      const file = path.join(dir, 'chumbaq-admin');
      run(`${shim}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'admin.example.com',
      });
      expect(readFileSync(file, 'utf8')).toContain('server_name admin.example.com;');

      run(`${shim}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'staff.example.com',
      });
      expect(readFileSync(file, 'utf8')).toContain('server_name staff.example.com;');
    });

    it('leaves the customer site too once certbot manages it', () => {
      const file = path.join(dir, 'chumbaq');
      const certbot = 'server {\n    ssl_certificate /etc/letsencrypt/live/x/fullchain.pem; # managed by Certbot\n}\n';
      writeFileSync(file, certbot);
      run(`${shim}write_site chumbaq customer_site_config`, { NGINX_SITES: dir });
      expect(readFileSync(file, 'utf8')).toBe(certbot);
    });

    // Run as someone who cannot read the file (not root), so grep fails with status 2.
    const unreadable = (file: string, contents: string) => {
      writeFileSync(file, contents);
      chmodSync(file, 0o000);
    };
    const runs = (body: string, env: Record<string, string>) => {
      try {
        return { ok: true, out: run(body, env) };
      } catch (error) {
        const e = error as { stdout: string; stderr: string };
        return { ok: false, out: `${e.stdout}${e.stderr}` };
      }
    };
    const asNonRoot = process.getuid?.() === 0 ? it.skip : it;

    asNonRoot('reads the site file through sudo, so a root-only certbot file is seen', () => {
      const file = path.join(dir, 'chumbaq-admin');
      unreadable(file, 'server {\n    listen 443 ssl; # managed by Certbot\n}\n');
      // A sudo that reads as root is the real one; here it is cat of a copy we may read.
      const copy = path.join(dir, 'copy');
      writeFileSync(copy, 'server {\n    listen 443 ssl; # managed by Certbot\n}\n');
      const rootSudo = `sudo() { if [ "\${@: -1}" = "${file}" ]; then set -- "\${@:1:$#-1}" "${copy}"; fi; "$@"; }\n`;
      expect(run(`${rootSudo}has_tls_config "${file}" && echo yes || echo no`).trim()).toBe('yes');
      // Without sudo the same file could not be read at all.
      expect(run(`has_tls_config "${file}" && echo yes || echo no`).trim()).not.toBe('yes');
    });

    asNonRoot('keeps a site file it cannot read, and stops', () => {
      const file = path.join(dir, 'chumbaq-admin');
      unreadable(file, 'server {\n    listen 443 ssl; # managed by Certbot\n}\n');
      const result = runs(`${shim}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'admin.example.com',
      });
      chmodSync(file, 0o600);
      expect(readFileSync(file, 'utf8')).toBe('server {\n    listen 443 ssl; # managed by Certbot\n}\n');
      expect(result.ok).toBe(false);
      expect(result.out).toContain(`Could not read ${file}`);
    });

    // sudo's own failure exits 1, like grep's "no match", and the next sudo may work (a
    // password mistyped once after the build outlived the sudo timestamp).
    it('keeps a certbot site when sudo fails once and then works, and stops', () => {
      const file = path.join(dir, 'chumbaq-admin');
      const certbot = 'server {\n    listen 443 ssl; # managed by Certbot\n}\n';
      writeFileSync(file, certbot);
      const flakySudo =
        'n=0; sudo() { n=$((n+1)); if [ $n -eq 1 ]; then echo "sudo: 3 incorrect password attempts" >&2; return 1; fi; "$@"; }\n';
      const result = runs(`${flakySudo}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'admin.example.com',
      });
      expect(readFileSync(file, 'utf8')).toBe(certbot);
      expect(result.ok).toBe(false);
      expect(result.out).toContain(`Could not read ${file}`);
    });

    it('cannot tell, rather than "no TLS", when sudo fails at all', () => {
      const status = (file: string) => run(`s=0; has_tls_config "${file}" || s=$?; echo $s`).trim();
      const plain = path.join(dir, 'plain');
      writeFileSync(plain, 'server {\n    listen 80;\n}\n');
      // The test harness's sudo always refuses.
      expect(status(plain)).toBe('2');
      expect(status(path.join(dir, 'missing'))).toBe('2');
    });

    it('notes that TLS from an include is not detected', () => {
      const file = path.join(dir, 'chumbaq-admin');
      writeFileSync(file, 'server {\n    listen 80;\n    include /etc/nginx/snippets/tls.conf;\n}\n');
      const out = run(`${shim}write_site chumbaq-admin admin_site_config`, {
        NGINX_SITES: dir,
        ADMIN_SERVER_NAME: 'admin.example.com',
      });
      expect(out).toMatch(/include/);
      expect(out).toMatch(/not detected/);
    });

    describe('sites-enabled', () => {
      let enabled: string;
      beforeEach(() => {
        enabled = path.join(dir, 'enabled');
        mkdirSync(enabled);
      });
      const enable = (name: string) =>
        run(`${shim}enable_site ${name}`, { NGINX_SITES: dir, NGINX_ENABLED: enabled });

      it('links a site that is not enabled yet, and keeps its own link', () => {
        enable('chumbaq-admin');
        expect(readlinkSync(path.join(enabled, 'chumbaq-admin'))).toBe(path.join(dir, 'chumbaq-admin'));
        enable('chumbaq-admin');
        expect(readlinkSync(path.join(enabled, 'chumbaq-admin'))).toBe(path.join(dir, 'chumbaq-admin'));
      });

      it.each(['chumbaq', 'chumbaq-admin'])('keeps a regular file in place of the %s link, and warns', (name) => {
        const entry = path.join(enabled, name);
        const certbot = 'server {\n    listen 443 ssl; # managed by Certbot\n}\n';
        writeFileSync(entry, certbot);
        const out = enable(name);
        expect(lstatSync(entry).isSymbolicLink()).toBe(false);
        expect(readFileSync(entry, 'utf8')).toBe(certbot);
        expect(out).toContain(`${entry} is a file`);
      });

      it('keeps a link that points somewhere else, and warns', () => {
        const entry = path.join(enabled, 'chumbaq-admin');
        symlinkSync('/etc/nginx/elsewhere', entry);
        const out = enable('chumbaq-admin');
        expect(readlinkSync(entry)).toBe('/etc/nginx/elsewhere');
        expect(out).toContain('/etc/nginx/elsewhere');
      });

      it('is how the script enables its sites', () => {
        const script = readFileSync(SCRIPT, 'utf8');
        const main = script.slice(script.indexOf('# Sourced by the tests'));
        expect(main).toContain('enable_site chumbaq-default\n');
        expect(main).toContain('enable_site "$SITE"\n');
        expect(main).toContain('enable_site "$SITE-admin"\n');
        expect(main).not.toMatch(/ln -sf/);
      });
    });

    describe('the whole script', () => {
      const matching =
        'ADMIN_APP_URL=https://admin.example.com\nVITE_ADMIN_APP_URL=https://admin.example.com\n' +
        'DATABASE_USER=chumbaq\nDATABASE_NAME=chumbaq\nDATABASE_PASSWORD=0123456789abcdef0123\n';

      // The control: the stubs let a good run reach the end, so the stops below are the
      // script's, not the harness's.
      it('writes and enables its sites and restarts nginx on a good run', () => {
        const result = runWholeScript(dir, { env: matching });
        expect([result.ok, result.out]).toEqual([true, expect.stringContaining('Setup Complete')]);
        expect(readFileSync(path.join(result.sites, 'chumbaq-admin'), 'utf8')).toContain('server_name admin.example.com;');
        const customer = readFileSync(path.join(result.sites, 'chumbaq'), 'utf8');
        expect(customer).toContain('server_name app.example.com;');
        expect(customer).not.toContain('default_server');
        expect(customer).toContain(`root ${result.app}/apps/web/dist;`);
        const fallback = readFileSync(path.join(result.sites, 'chumbaq-default'), 'utf8');
        expect(fallback).toContain('default_server');
        expect(fallback).toContain('return 444;');
        for (const site of ['chumbaq-default', 'chumbaq', 'chumbaq-admin']) {
          expect(readlinkSync(path.join(result.enabled, site))).toBe(path.join(result.sites, site));
        }
        expect(result.log).toContain('sudo systemctl restart nginx');
        expect(result.log).toContain('npm run build:admin');
        expect(result.log).toContain('npm ci');
        // Upgrades keep the config files the script edits, rather than prompting over SSH.
        const keep = readFileSync(path.join(result.system, 'etc/apt/apt.conf.d/90chumbaq-keep-config'), 'utf8');
        expect(keep).toContain('"--force-confold";');
        const lines = result.log.split('\n');
        expect(lines.findIndex((l) => l.includes('90chumbaq-keep-config'))).toBeLessThan(lines.indexOf('sudo apt upgrade -y'));
      });

      // Each process reads its .env as ../../.env from where it runs (the ecosystem file
      // runs them from apps/api); and the customer API (which migrates) must be healthy
      // before the admin API and the worker start.
      it('starts the three processes one at a time, the customer API first', () => {
        const result = runWholeScript(dir, { env: matching });
        expect(result.ok).toBe(true);
        const up = (name: string) =>
          result.log.indexOf(
            `PM2_PREFIX=chumbaq pm2 startOrReload ${result.app}/ecosystem.config.cjs --env production --only ${name} --update-env`,
          );
        const api = up('chumbaq-api');
        const health = result.log.indexOf('curl -fsS -o /dev/null http://127.0.0.1:3000/api/health');
        const admin = up('chumbaq-admin-api');
        const worker = up('chumbaq-worker');
        expect([api, health, admin, worker].every((i) => i > -1)).toBe(true);
        expect(api).toBeLessThan(health);
        expect(health).toBeLessThan(admin);
        expect(health).toBeLessThan(worker);
        expect(result.log).toContain('pm2 save');
      });

      it('clones the repository only when there is no checkout', () => {
        const result = runWholeScript(dir, { env: matching });
        expect(result.log).toContain(`git clone --branch main git@example.com:chumbaq-platform.git ${result.app}`);
        writeFileSync(path.join(result.app, 'package.json'), '{}');
        const again = runWholeScript(dir, { env: matching });
        expect(again.ok).toBe(true);
        expect(again.log).not.toMatch(/^git clone/m);
      });

      it('keeps stage apart: its own sites, processes and ports', () => {
        const result = runWholeScript(dir, {
          env: matching.replace(/admin\.example\.com/g, 'admin-stage.example.com'),
          vars: { DEPLOY_ENV: 'stage', ADMIN_SERVER_NAME: 'admin-stage.example.com', APP_SERVER_NAME: 'stage.example.com' },
        });
        expect([result.ok, result.out]).toEqual([true, expect.stringContaining('Setup Complete')]);
        expect(readFileSync(path.join(result.sites, 'chumbaq-stage'), 'utf8')).toContain('proxy_pass http://127.0.0.1:3100;');
        expect(readFileSync(path.join(result.sites, 'chumbaq-stage-admin'), 'utf8')).toContain(
          'proxy_pass http://127.0.0.1:3111;',
        );
        expect(existsSync(path.join(result.sites, 'chumbaq'))).toBe(false);
        expect(result.log).toContain('PM2_PREFIX=chumbaq-stage pm2 startOrReload');
        expect(result.log).toContain('--only chumbaq-stage-api');
        expect(result.log).toContain('--only chumbaq-stage-worker');
        expect(result.log).toContain('http://127.0.0.1:3100/api/health');
        expect(readFileSync(path.join(result.app, '.env'), 'utf8')).toMatch(/^REDIS_DB=1$/m);
      });

      // The clock, logs, alarms and file check are the server's, and the alarm script posts
      // to prod's admin API: stage writing its own token there would cut prod's alarms off.
      it('leaves the server-wide CERT-In pieces to prod', () => {
        const result = runWholeScript(dir, {
          env: matching.replace(/admin\.example\.com/g, 'admin-stage.example.com'),
          vars: { DEPLOY_ENV: 'stage', ADMIN_SERVER_NAME: 'admin-stage.example.com', APP_SERVER_NAME: 'stage.example.com' },
        });
        expect([result.ok, result.out]).toEqual([true, expect.stringContaining('stage skips them')]);
        expect(existsSync(path.join(result.system, 'etc/chumbaq/alert-token'))).toBe(false);
        expect(existsSync(path.join(result.system, 'etc/logrotate.d/chumbaq-retention'))).toBe(false);
        expect(result.log).not.toMatch(/apt install -y chrony|aideinit|aide --update/);
        expect(readFileSync(path.join(result.app, '.env'), 'utf8')).not.toMatch(/^SECURITY_ALERT_TOKEN=/m);
        // Redis is still set up: stage's queues need it.
        expect(result.log).toContain('sudo systemctl restart redis-server');
      });

      describe('Redis, shared by every environment on the server', () => {
        const redisConf = (root: string, contents: string) => {
          mkdirSync(path.join(root, 'system/etc/redis'), { recursive: true });
          writeFileSync(path.join(root, 'system/etc/redis/redis.conf'), contents);
        };
        const password = 'a1b2c3d4e5f6a7b8c9d0e1f2';

        it('gives a .env without one the password Redis already has', () => {
          redisConf(dir, `bind 127.0.0.1\nrequirepass ${password}\n`);
          const result = runWholeScript(dir, { env: matching });
          expect(result.ok).toBe(true);
          const env = readFileSync(path.join(result.app, '.env'), 'utf8');
          expect(env).toContain(`REDIS_PASSWORD=${password}`);
          expect(env).toMatch(/^REDIS_DB=0$/m);
          expect(readFileSync(path.join(result.system, 'etc/redis/redis.conf'), 'utf8')).toMatch(
            new RegExp(`^requirepass ${password}$`, 'm'),
          );
        });

        it('stops before the build when the .env names another password', () => {
          redisConf(dir, `requirepass ${password}\n`);
          const result = runWholeScript(dir, { env: `${matching}REDIS_PASSWORD=ffffffffffffffffffffffff\n` });
          expect(result.ok).toBe(false);
          expect(result.out).toContain('differs from the one in /etc/redis/redis.conf');
          expect(result.log).not.toMatch(/^npm /m);
          expect(result.log).not.toContain('restart redis-server');
          expect(readFileSync(path.join(dir, 'system/etc/redis/redis.conf'), 'utf8')).toContain(`requirepass ${password}`);
        });
      });

      it('refuses a database name or password from the .env that it would put into SQL', () => {
        const result = runWholeScript(dir, {
          env: matching.replace('DATABASE_USER=chumbaq', "DATABASE_USER=x'; DROP ROLE postgres; --"),
        });
        expect(result.ok).toBe(false);
        expect(result.out).toContain('DATABASE_USER and DATABASE_NAME');
        expect(result.log).not.toMatch(/psql/);
        expect(result.log).not.toMatch(/^npm /m);
      });

      it('sets up the CERT-In pieces: 180-day logs, NIC/NPL clock, Redis, the worker, alarms', () => {
        const result = runWholeScript(dir, { env: matching });
        expect(result.ok).toBe(true);
        const sys = (rel: string) => readFileSync(path.join(result.system, rel), 'utf8');
        expect(sys('etc/logrotate.d/chumbaq-retention')).toMatch(/rotate 365/);
        expect(sys('etc/chrony/conf.d/chumbaq.conf')).toContain('server samay1.nic.in iburst');
        expect(sys('etc/nginx/conf.d/chumbaq-logging.conf')).toContain('log_format chumbaq');
        expect(sys('usr/local/sbin/chumbaq-security-alert')).toContain('/api/internal/security-alerts');
        expect(sys('etc/pam.d/sshd')).toContain('pam_exec.so quiet /usr/local/sbin/chumbaq-ssh-login-alert');
        expect(sys('etc/fail2ban/jail.d/chumbaq.conf')).toContain('maxretry = 5');
        expect(sys('etc/cron.daily/chumbaq-aide')).toContain('aide --check');
        expect(result.log).toMatch(/^sudo apt install -y chrony$/m);
        expect(result.log).toMatch(/^sudo apt install -y redis-server$/m);
        expect(result.log).toMatch(/^sudo apt install -y fail2ban aide$/m);
        // Packages that ship their own rotation rules are installed before the rules are swapped.
        const lines = result.log.split('\n');
        const lastInstall = Math.max(...['chrony', 'redis-server', 'fail2ban aide'].map((p) => lines.indexOf(`sudo apt install -y ${p}`)));
        expect(lines.findIndex((l) => l.startsWith('sudo logrotate --debug'))).toBeGreaterThan(lastInstall);
        expect(result.log).toMatch(/^sudo install -o root -g root -m 0755 .*collect-logs\.sh .*usr\/local\/sbin\/chumbaq-collect-logs$/m);
        expect(result.log).toMatch(/^PM2_PREFIX=chumbaq pm2 startOrReload \S+\/ecosystem\.config\.cjs --env production --only chumbaq-api --update-env$/m);
        expect(result.log).not.toMatch(/^pm2 start /m);
        const env = readFileSync(path.join(result.app, '.env'), 'utf8');
        expect(env).toMatch(/^REDIS_PASSWORD=[0-9a-f]{48}$/m);
        expect(env).toMatch(/^SECURITY_ALERT_TOKEN=[0-9a-f]{64}$/m);
        expect(sys('etc/chumbaq/alert-token').trim()).toBe(/^SECURITY_ALERT_TOKEN=(\S+)$/m.exec(env)![1]);
        // Both sites refuse the internal route and pass nginx's request id on.
        for (const site of ['chumbaq', 'chumbaq-admin']) {
          const conf = readFileSync(path.join(result.sites, site), 'utf8');
          expect(conf).toMatch(/location \/api\/internal\/ \{\s*return 404;/);
          expect(conf).toContain('proxy_set_header X-Request-Id $request_id;');
          expect(conf).toContain('location = /.well-known/security.txt');
        }
      });

      // A second run (stage, or prod again) takes a new baseline at the end, so anything
      // changed since the last one must be raised first, before apt or the build.
      it('checks files against an existing baseline before changing anything', () => {
        mkdirSync(path.join(dir, 'system/etc/cron.daily'), { recursive: true });
        mkdirSync(path.join(dir, 'system/var/lib/aide'), { recursive: true });
        writeFileSync(path.join(dir, 'system/etc/cron.daily/chumbaq-aide'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
        writeFileSync(path.join(dir, 'system/var/lib/aide/aide.db'), '');
        const result = runWholeScript(dir, { env: matching });
        expect(result.ok).toBe(true);
        const lines = result.log.split('\n');
        const check = lines.findIndex((l) => l.startsWith('sudo ') && l.endsWith('etc/cron.daily/chumbaq-aide'));
        expect(check).toBeGreaterThanOrEqual(0);
        expect(check).toBeLessThan(lines.findIndex((l) => l.startsWith('sudo apt')));
        expect(check).toBeLessThan(lines.findIndex((l) => /aide --update/.test(l)));
      });

      it('stops before installing anything when LOG_RETENTION_DAYS is under 180', () => {
        const result = runWholeScript(dir, { env: `${matching}LOG_RETENTION_DAYS=179\n` });
        expect(result.ok).toBe(false);
        expect(result.out).toContain('at least 180 (CERT-In requires 180 days of logs)');
        expect(result.log).not.toMatch(/apt|npm|pm2/);
      });

      // A site it could not read is kept and the run stops there: going on would enable
      // and restart nginx around a site nobody checked (`write_site ... || true`).
      it.each(['chumbaq', 'chumbaq-admin'])('stops, keeping %s, when it cannot read it', (name) => {
        const certbot = 'server {\n    listen 443 ssl; # managed by Certbot\n}\n';
        const file = path.join(dir, 'sites-available', name);
        const result = runWholeScript(dir, { env: matching, failRead: file, sites: { [name]: certbot } });
        expect(result.ok).toBe(false);
        expect(result.out).toContain(`Could not read ${file}`);
        expect(readFileSync(file, 'utf8')).toBe(certbot);
        expect(result.log).not.toMatch(/nginx -t|systemctl restart nginx|^sudo ln /m);
        expect(existsSync(path.join(result.enabled, name))).toBe(false);
      });
    });
  });
});

/**
 * ecosystem.config.cjs: the processes the deploy scripts start, one environment at a time.
 * Each loads its .env as ../../.env from where it runs, so they must run from apps/api.
 */
describe('ecosystem.config.cjs', () => {
  const FILE = path.resolve(__dirname, '../../../../ecosystem.config.cjs');
  const load = (prefix?: string): { name: string; script: string; cwd: string }[] => {
    const out = execFileSync('node', ['-e', `console.log(JSON.stringify(require(${JSON.stringify(FILE)}).apps))`], {
      env: { PATH: process.env.PATH, ...(prefix ? { PM2_PREFIX: prefix } : {}) },
      encoding: 'utf8',
    });
    return JSON.parse(out) as { name: string; script: string; cwd: string }[];
  };

  it('runs the API, admin API and worker from apps/api, so ../../.env is the repo .env', () => {
    const apps = load();
    expect(apps.map((a) => a.name)).toEqual(['chumbaq-api', 'chumbaq-admin-api', 'chumbaq-worker']);
    expect(apps.map((a) => a.script)).toEqual(['dist/main.js', 'dist/main-admin.js', 'dist/worker.js']);
    for (const a of apps) {
      expect(a.cwd).toBe(path.resolve(__dirname, '../../../../apps/api'));
      expect(path.resolve(a.cwd, '../../.env')).toBe(path.resolve(__dirname, '../../../../.env'));
    }
  });

  it("names each environment's processes from PM2_PREFIX", () => {
    expect(load('chumbaq-stage').map((a) => a.name)).toEqual([
      'chumbaq-stage-api',
      'chumbaq-stage-admin-api',
      'chumbaq-stage-worker',
    ]);
  });
});
