import { execFileSync, spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * scripts/collect-logs.sh gathers the logs for a time window into one root-only archive
 * for CERT-In. Run here against a fake /var/log, with the database export stubbed.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/collect-logs.sh');

describe('collect-logs.sh', () => {
  let root: string;
  let logs: string;
  let pm2: string;
  let out: string;

  const file = (rel: string, body: string, mtime?: Date) => {
    const p = path.join(logs, rel);
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(p, body);
    if (mtime) utimesSync(p, mtime, mtime);
  };

  const run = (from: string, to: string) =>
    spawnSync('bash', [SCRIPT, '--from', from, '--to', to, '--out', out], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        LOG_ROOT: logs,
        PM2_LOG_DIR: pm2,
        COLLECT_LOGS_ALLOW_NON_ROOT: '1',
        // The database export, stubbed: writes one CSV where it is told.
        DB_EXPORT_CMD: `node -e "require('fs').writeFileSync(process.argv[1] + '/auth_events.csv', 'id\\n1\\n')"`,
      },
    });

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), 'collect-logs-'));
    logs = path.join(root, 'var-log');
    pm2 = path.join(root, 'pm2');
    out = path.join(root, 'out');
    mkdirSync(pm2, { recursive: true });
    mkdirSync(out);
    const old = new Date('2026-10-01T00:00:00Z');
    file('nginx/access.log', 'current access\n');
    file('nginx/access.log-20261111.gz', 'in window\n');
    file('nginx/access.log-20261109', 'day before the window, kept for the margin\n');
    file('nginx/access.log-20261101.gz', 'long before\n');
    file('auth.log', 'current auth\n');
    file('auth.log-20261112', 'day after the window, kept for the margin\n');
    file('auth.log-20261120', 'long after\n');
    file('syslog.1', 'undated, old', old);
    file('postgresql/postgresql-16-main.log', 'pg current\n');
    file('nginx/.env.backup', 'SECRET=1\n');
    file('nginx/server.key', 'KEY\n');
    writeFileSync(path.join(pm2, 'chumbaq-api-out__20261111.log'), 'api in window\n');
    writeFileSync(path.join(pm2, 'chumbaq-api-out.log'), 'api current\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  const unpack = (archive: string) => {
    const dir = path.join(root, 'unpacked');
    mkdirSync(dir);
    execFileSync('tar', ['-xzf', archive, '-C', dir]);
    const [top] = readdirSync(dir);
    return path.join(dir, top);
  };

  it('packs the window’s logs, current ones, the database CSVs and a manifest with checksums', () => {
    const res = run('2026-11-10T08:00:00Z', '2026-11-11T10:00:00Z');
    expect(res.stderr).toBe('');
    expect(res.status).toBe(0);
    const archive = res.stdout.trim().split('\n').pop()!;
    expect(archive).toMatch(/chumbaq-logs-20261110T080000Z-20261111T100000Z\.tar\.gz$/);
    expect((require('fs').statSync(archive).mode & 0o777).toString(8)).toBe('600');

    const top = unpack(archive);
    const listed = (sub: string) => readdirSync(path.join(top, sub)).sort();
    expect(listed('var-log/nginx')).toEqual(['access.log', 'access.log-20261109', 'access.log-20261111.gz']);
    expect(listed('var-log')).toEqual(expect.arrayContaining(['auth.log', 'auth.log-20261112', 'postgresql']));
    expect(listed('var-log')).not.toContain('auth.log-20261120');
    expect(listed('var-log')).not.toContain('syslog.1');
    expect(listed('pm2')).toEqual(['chumbaq-api-out.log', 'chumbaq-api-out__20261111.log']);
    expect(listed('database')).toEqual(['auth_events.csv']);

    const manifest = readFileSync(path.join(top, 'MANIFEST.txt'), 'utf8');
    expect(manifest).toContain('Window: 2026-11-10T08:00:00Z to 2026-11-11T10:00:00Z');
    expect(manifest).toMatch(/Clock: /);
    const sha = createHash('sha256').update(readFileSync(path.join(top, 'var-log/nginx/access.log-20261111.gz'))).digest('hex');
    expect(manifest).toContain(`${sha}  var-log/nginx/access.log-20261111.gz`);
  });

  it('refuses to overwrite an earlier archive, and leaves no work files behind', () => {
    const first = run('2026-11-10T08:00:00Z', '2026-11-11T10:00:00Z');
    expect(first.status).toBe(0);
    const again = run('2026-11-10T08:00:00Z', '2026-11-11T10:00:00Z');
    expect(again.status).not.toBe(0);
    expect(again.stderr).toMatch(/already exists/);
    expect(readdirSync(out)).toEqual(['chumbaq-logs-20261110T080000Z-20261111T100000Z.tar.gz']);
  });

  it('never packs a .env file or a key', () => {
    const res = run('2026-11-10T08:00:00Z', '2026-11-11T10:00:00Z');
    const top = unpack(res.stdout.trim().split('\n').pop()!);
    expect(readdirSync(path.join(top, 'var-log/nginx'))).not.toEqual(expect.arrayContaining(['.env.backup']));
    expect(readdirSync(path.join(top, 'var-log/nginx'))).not.toContain('server.key');
  });

  it('refuses a reversed or unreadable window, and runs only as root', () => {
    expect(run('2026-11-11T10:00:00Z', '2026-11-10T08:00:00Z').status).not.toBe(0);
    expect(run('yesterday', '2026-11-10T08:00:00Z').status).not.toBe(0);
    const asUser = spawnSync('bash', [SCRIPT, '--from', '2026-11-10T08:00:00Z', '--to', '2026-11-11T10:00:00Z'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH },
    });
    expect(asUser.status).not.toBe(0);
    expect(asUser.stderr).toMatch(/root/);
  });
});
