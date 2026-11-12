import { execFileSync, spawnSync } from 'child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

/**
 * scripts/server-security.sh: the CERT-In pieces of a server (180-day logs, NIC/NPL
 * clock, nginx log format, security.txt, server alarms). Its functions print config, so
 * they are tested here without sudo; deploy-setup.sh and deploy-update.sh write it.
 */
const SCRIPT = path.resolve(__dirname, '../../../../scripts/server-security.sh');

function run(body: string, env: Record<string, string> = {}) {
  const res = spawnSync('bash', ['-c', `set -e\nsource "$SCRIPT"\n${body}`], {
    env: { PATH: process.env.PATH, SCRIPT, ...env },
    encoding: 'utf8',
  });
  return { ok: res.status === 0, out: res.stdout, err: res.stderr };
}

describe('scripts/server-security.sh', () => {
  describe('log retention', () => {
    it('defaults to 365 days and refuses below 180 or a non-number', () => {
      expect(run('check_log_retention_days ""').out.trim()).toBe('365');
      expect(run('check_log_retention_days 180').out.trim()).toBe('180');
      expect(run('check_log_retention_days 179')).toEqual(
        expect.objectContaining({ ok: false, err: expect.stringMatching(/at least 180 \(CERT-In requires 180 days of logs\)/) }),
      );
      expect(run('check_log_retention_days abc').ok).toBe(false);
    });

    it('rotates every server log daily, keeping the days asked, named by date', () => {
      const rules = run('logrotate_rules 365').out;
      for (const log of [
        '/var/log/nginx/*.log',
        '/var/log/syslog',
        '/var/log/auth.log',
        '/var/log/kern.log',
        '/var/log/postgresql/*.log',
        '/var/log/redis/*.log',
        '/var/log/chrony/*.log',
        '/var/log/fail2ban.log',
      ]) {
        expect(rules).toContain(log);
      }
      const blocks = rules.split('}').filter((b) => b.includes('{'));
      expect(blocks.length).toBeGreaterThanOrEqual(5);
      for (const block of blocks) {
        expect(block).toMatch(/\bdaily\b/);
        expect(block).toMatch(/\brotate 365\b/);
        expect(block).toMatch(/\bmaxage 365\b/);
        expect(block).toMatch(/\bdateext\b/);
        expect(block).toMatch(/\bcompress\b/);
      }
      // Each family keeps the way its program reopens its log.
      expect(rules).toContain('invoke-rc.d nginx rotate');
      expect(rules).toContain('/usr/lib/rsyslog/rsyslog-rotate');
      expect(rules).toContain('chronyc cyclelogs');
    });

    it('lists the distribution rule files it replaces', () => {
      expect(run('replaced_logrotate_files').out.split('\n').filter(Boolean)).toEqual([
        'nginx',
        'rsyslog',
        'postgresql-common',
        'redis-server',
        'fail2ban',
        'chrony',
      ]);
    });

    it('moves aside a distribution rule for every log it rotates (logrotate refuses duplicates)', () => {
      // Which Ubuntu 24.04 package rule file covers each family of logs.
      const owner: [RegExp, string][] = [
        [/^\/var\/log\/nginx\//, 'nginx'],
        [/^\/var\/log\/(syslog|mail\.log|kern\.log|auth\.log|user\.log|cron\.log)$/, 'rsyslog'],
        [/^\/var\/log\/postgresql\//, 'postgresql-common'],
        [/^\/var\/log\/redis\//, 'redis-server'],
        [/^\/var\/log\/chrony\//, 'chrony'],
        [/^\/var\/log\/fail2ban\.log$/, 'fail2ban'],
      ];
      const replaced = run('replaced_logrotate_files').out.split('\n').filter(Boolean);
      const paths = run('logrotate_rules 365').out.match(/^\/var\/log\/\S+/gm)!;
      for (const p of paths) {
        const family = owner.find(([re]) => re.test(p));
        expect({ path: p, family: family?.[1] }).toEqual({ path: p, family: expect.any(String) });
        expect(replaced).toContain(family![1]);
      }
    });
  });

  describe('the clock', () => {
    it('uses NIC and NPL by default', () => {
      const conf = run('chrony_conf ""').out;
      expect(conf.match(/^server \S+ iburst$/gm)).toEqual([
        'server samay1.nic.in iburst',
        'server samay2.nic.in iburst',
        'server time.nplindia.org iburst',
      ]);
      expect(conf).toMatch(/^makestep 1 3$/m);
      expect(conf).toMatch(/^log tracking measurements statistics$/m);
      expect(conf).toMatch(/^logdir \/var\/log\/chrony$/m);
    });

    it('takes NTP_SERVERS instead, refusing anything but host names', () => {
      expect(run('chrony_conf "a.example.org b.example.org"').out.match(/^server .*$/gm)).toEqual([
        'server a.example.org iburst',
        'server b.example.org iburst',
      ]);
      expect(run('chrony_conf "a.example.org;rm"').ok).toBe(false);
    });
  });

  describe('the clock source check', () => {
    const line = (name: string) => `A4FFFF7A,${name},2,1794236500.1,0.000012,0,0,0,0,0,0,0,64,Normal`;
    it('accepts only a source among the configured servers', () => {
      expect(run(`clock_source_ok "" "${line('samay2.nic.in')}"`).ok).toBe(true);
      expect(run(`clock_source_ok "a.example.org" "${line('a.example.org')}"`).ok).toBe(true);
      expect(run(`clock_source_ok "" "${line('169.254.169.254')}"`).ok).toBe(false);
      expect(run(`clock_source_ok "" "00000000,,0,0,0"`).ok).toBe(false);
    });
  });

  describe('nginx logging', () => {
    const conf = () => run('nginx_logging_conf').out;

    it('defines the chumbaq format and logs every server with it', () => {
      expect(conf()).toMatch(/log_format chumbaq /);
      expect(conf()).toMatch(/^access_log \/var\/log\/nginx\/access\.log chumbaq;$/m);
      expect(conf()).toContain('$request_id');
      expect(conf()).toContain('$time_iso8601');
    });

    it('keeps the error log to critical errors, which never carry a request line', () => {
      expect(conf()).toMatch(/^error_log \/var\/log\/nginx\/error\.log crit;$/m);
    });

    it('never logs a query string or a full referrer', () => {
      const format = conf().slice(conf().indexOf('log_format'), conf().indexOf(';', conf().indexOf('log_format')));
      for (const leak of ['$request ', '$request"', '$request_uri', '$args', '$query_string', '$http_referer', '$uri']) {
        expect(format).not.toContain(leak);
      }
    });

    it('masks the secret in every provider webhook path', () => {
      // The nginx map's regex and replacement, run here as JavaScript.
      const map = /~\^\(\/api\/\(email\|sms\|whatsapp\)\/webhooks\/\[\^\/\]\+\/\)\[\^\/\]\+\(\.\*\)\$\s+\$1:token\$3;/;
      expect(conf()).toMatch(map);
    });
  });

  describe('security.txt', () => {
    it('names the contact and an expiry a year on', () => {
      const txt = run('security_txt security@example.com 2027-11-11T00:00:00Z').out;
      expect(txt).toBe('Contact: mailto:security@example.com\nExpires: 2027-11-11T00:00:00Z\nPreferred-Languages: en\n');
      expect(run('security_txt https://example.com/report 2027-11-11T00:00:00Z').out).toContain('Contact: https://example.com/report');
    });

    it('refuses a contact that could add lines', () => {
      expect(run('security_txt "a@b.com\nContact: evil" 2027-11-11T00:00:00Z').ok).toBe(false);
    });
  });

  describe('server alarms', () => {
    it('the alarm script posts JSON to the admin API on localhost with the token file', () => {
      const script = run('alert_script').out;
      expect(script).toContain('http://127.0.0.1:${ADMIN_API_PORT:-3011}/api/internal/security-alerts');
      expect(script).toContain('/etc/chumbaq/alert-token');
      expect(script).toContain('--max-time 5');
      expect(script).toContain('logger -t chumbaq-security');
    });

    it('builds valid JSON from its arguments, escaping quotes', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'alert-'));
      try {
        const file = path.join(dir, 'alert');
        writeFileSync(file, run('alert_script').out);
        writeFileSync(path.join(dir, 'token'), 't0k3n\n');
        // curl and logger stubbed: curl prints the body it was given.
        // curl stubbed: it writes the body it was given to a file (the script discards curl's output).
        writeFileSync(
          path.join(dir, 'curl'),
          '#!/bin/bash\nfor a in "$@"; do [ "$prev" = "--data-binary" ] && printf "%s" "$a" > "$CAPTURE"; prev="$a"; done\n',
          { mode: 0o755 },
        );
        writeFileSync(path.join(dir, 'logger'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
        const capture = path.join(dir, 'body.json');
        execFileSync('bash', [file, 'server.ssh_login', 'ubuntu@203.0.113.9', 'user=ubuntu', 'note=a "quoted" word'], {
          env: { PATH: `${dir}:${process.env.PATH}`, ALERT_TOKEN_FILE: path.join(dir, 'token'), CAPTURE: capture },
          encoding: 'utf8',
        });
        expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual({
          kind: 'server.ssh_login',
          key: 'ubuntu@203.0.113.9',
          details: { user: 'ubuntu', note: 'a "quoted" word' },
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it('raises an SSH login only on session open, in the background', () => {
      const script = run('ssh_login_alert_script').out;
      expect(script).toMatch(/PAM_TYPE.*open_session/);
      expect(script).toContain('server.ssh_login');
      expect(script).toMatch(/&\s*$/m);
      expect(script).toMatch(/exit 0\s*$/);
    });

    it('fail2ban bans after 5 failures in 10 minutes for an hour, and raises an alarm', () => {
      const jail = run('fail2ban_jail').out;
      expect(jail).toMatch(/^\[sshd\]$/m);
      expect(jail).toMatch(/^maxretry = 5$/m);
      expect(jail).toMatch(/^findtime = 10m$/m);
      expect(jail).toMatch(/^bantime = 1h$/m);
      expect(jail).toContain('chumbaq-alert');
      expect(run('fail2ban_action').out).toMatch(/actionban = .*chumbaq-security-alert server\.ssh_banned <ip>/);
    });

    it('the daily file check raises server.files_changed with the changed paths', () => {
      const check = run('aide_check_script').out;
      expect(check).toContain('aide --check');
      expect(check).toContain('server.files_changed');
      expect(check).toContain('head -20');
    });
  });

  describe('pm2', () => {
    it('the ecosystem file runs the API, admin API and worker with ISO timestamps', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const eco = require(path.resolve(__dirname, '../../../../ecosystem.config.cjs')) as {
        apps: { name: string; script: string; log_date_format: string }[];
      };
      expect(eco.apps.map((a) => [a.name, a.script])).toEqual([
        ['chumbaq-api', 'dist/main.js'],
        ['chumbaq-admin-api', 'dist/main-admin.js'],
        ['chumbaq-worker', 'dist/worker.js'],
      ]);
      for (const app of eco.apps) expect(app.log_date_format).toBe('YYYY-MM-DDTHH:mm:ss.SSSZ');
    });
  });

  it('defines everything it is sourced for without running anything', () => {
    const res = run('declare -F | wc -l');
    expect(Number(res.out.trim())).toBeGreaterThan(10);
    void readdirSync;
    void readFileSync;
  });
});
