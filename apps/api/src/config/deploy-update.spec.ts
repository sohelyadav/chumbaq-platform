import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * scripts/deploy-update.sh, run whole with git, npm, pm2, sudo and chronyc stubbed: an
 * update re-applies the CERT-In server pieces, rebuilds every app, reloads all three
 * processes from the ecosystem file, and only then takes the new file baseline.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/deploy-update.sh');

function runUpdate(root: string, env = 'LOG_RETENTION_DAYS=365\n', vars: Record<string, string> = {}) {
  const app = path.join(root, 'app');
  const bin = path.join(root, 'bin');
  const log = path.join(root, 'log');
  mkdirSync(app, { recursive: true });
  mkdirSync(bin, { recursive: true });
  writeFileSync(path.join(app, '.env'), env);
  writeFileSync(log, '');
  // A server set up before: the daily file check and its baseline are in place.
  const sys = path.join(root, 'system');
  mkdirSync(path.join(sys, 'etc/cron.daily'), { recursive: true });
  mkdirSync(path.join(sys, 'var/lib/aide'), { recursive: true });
  writeFileSync(path.join(sys, 'etc/cron.daily/chumbaq-aide'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  writeFileSync(path.join(sys, 'var/lib/aide/aide.db'), '');
  const stub = (name: string, body: string) => {
    writeFileSync(path.join(bin, name), `#!/bin/bash\n${body}\n`);
    chmodSync(path.join(bin, name), 0o755);
  };
  for (const name of ['npm', 'pm2', 'curl']) stub(name, `printf "${name} %s\\n" "$*" >> "$STUB_LOG"`);
  // git diff --quiet fails, as for a checkout with local edits, when STUB_GIT_DIRTY is set.
  stub('git', 'printf "git %s\\n" "$*" >> "$STUB_LOG"\n[ "$1" = diff ] && [ -n "${STUB_GIT_DIRTY:-}" ] && exit 1\nexit 0');
  stub('chronyc', 'echo "A4FFFF7A,samay1.nic.in,2,1794236500.1,0.000012,0,0,0,0,0,0,0,64,Normal"');
  stub(
    'sudo',
    ['printf "sudo %s\\n" "$*" >> "$STUB_LOG"', 'case $1 in', '  grep|tee|mkdir|chmod|mv|rm) exec "$@" ;;', '  *) exit 0 ;;', 'esac'].join('\n'),
  );
  let ok = true;
  let out = '';
  try {
    out = execFileSync('bash', [SCRIPT, 'main'], {
      env: { PATH: `${bin}:${process.env.PATH}`, APP_DIR: app, STUB_LOG: log, SYSTEM_ROOT: path.join(root, 'system'), ...vars },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    ok = false;
    const e = error as { stdout: string; stderr: string };
    out = `${e.stdout}${e.stderr}`;
  }
  return { ok, out, log: readFileSync(log, 'utf8'), system: path.join(root, 'system') };
}

describe('scripts/deploy-update.sh', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'deploy-update-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('re-applies the server pieces, builds every app and reloads all three processes', () => {
    const result = runUpdate(dir);
    expect([result.ok, result.out]).toEqual([true, expect.stringContaining('Deployed main to prod')]);
    expect(readFileSync(path.join(result.system, 'etc/logrotate.d/chumbaq-retention'), 'utf8')).toMatch(/rotate 365/);
    expect(result.log).toMatch(/^npm run build:admin$/m);
    for (const name of ['chumbaq-api', 'chumbaq-admin-api', 'chumbaq-worker']) {
      expect(result.log).toMatch(new RegExp(`^pm2 startOrReload \\S+/ecosystem\\.config\\.cjs --env production --only ${name} --update-env$`, 'm'));
    }
    expect(result.log).toMatch(/^npm ci$/m);
    expect(result.log).not.toMatch(/^pm2 restart chumbaq-api$/m);
    const lines = result.log.split('\n');
    const reload = lines.findIndex((l) => l.startsWith('pm2 startOrReload'));
    const baseline = lines.findIndex((l) => /aideinit|aide --update/.test(l));
    expect(baseline).toBeGreaterThan(reload);
    expect(result.log).toMatch(/^sudo nginx -t$/m);
  });

  it('stops before anything when the checkout has uncommitted changes', () => {
    const result = runUpdate(dir, 'LOG_RETENTION_DAYS=365\n', { STUB_GIT_DIRTY: '1' });
    expect(result.ok).toBe(false);
    expect(result.out).toContain('uncommitted changes');
    expect(result.log).not.toMatch(/^git (fetch|pull)/m);
    expect(result.log).not.toMatch(/^npm /m);
  });

  it('leaves the server-wide pieces to prod when updating stage', () => {
    const result = runUpdate(dir, 'LOG_RETENTION_DAYS=365\n', { DEPLOY_ENV: 'stage' });
    expect([result.ok, result.out]).toEqual([true, expect.stringContaining('Deployed main to stage')]);
    expect(result.log).not.toMatch(/apt install -y chrony/);
    expect(result.log).toMatch(/--only chumbaq-stage-api --update-env$/m);
    expect(result.log).toContain('curl -fsS -o /dev/null http://127.0.0.1:3100/api/health');
    // Prod has a baseline here, so stage's changed files move it on.
    expect(result.log).toMatch(/aide --update/);
  });

  it('checks files against the old baseline before changing anything, so a deploy never hides a change', () => {
    const result = runUpdate(dir);
    const lines = result.log.split('\n');
    const check = lines.findIndex((l) => /chumbaq-aide/.test(l) && l.startsWith('sudo '));
    expect(check).toBeGreaterThanOrEqual(0);
    // Only the read-only uncommitted-changes check (git diff) may come before it.
    expect(check).toBeLessThan(lines.findIndex((l) => l.startsWith('git ') && !l.startsWith('git diff')));
  });

  it('restarts Redis (with its password) only just before the processes reload', () => {
    const result = runUpdate(dir);
    const lines = result.log.split('\n');
    const redis = lines.findIndex((l) => l === 'sudo systemctl restart redis-server');
    expect(redis).toBeGreaterThan(lines.findIndex((l) => l === 'npm run build:admin'));
    expect(redis).toBeLessThan(lines.findIndex((l) => l.startsWith('pm2 startOrReload')));
  });

  it('rotates PM2 logs by day only, so a busy day never overwrites its own file', () => {
    expect(runUpdate(dir).log).toMatch(/^pm2 set pm2-logrotate:max_size 100G$/m);
  });

  it('stops before pulling anything when LOG_RETENTION_DAYS is under 180', () => {
    const result = runUpdate(dir, 'LOG_RETENTION_DAYS=90\n');
    expect(result.ok).toBe(false);
    expect(result.out).toContain('at least 180');
    expect(result.log).not.toMatch(/^git /m);
  });
});
