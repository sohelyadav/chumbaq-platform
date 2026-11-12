// See collect-logs.sh. Settings (environment) for other layouts and for tests:
//   LOG_ROOT (/var/log), PM2_LOG_DIR (/home/ubuntu/.pm2/logs), APP_DIR (/home/ubuntu/chumbaq),
//   APP_USER (ubuntu), DB_EXPORT_CMD (replaces the database export; gets the output dir as $1).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';

// Nothing this writes is readable by anyone but root (and the app user, for its own CSVs).
process.umask(0o077);

const DAY = 24 * 3600_000;
const LOG_ROOT = process.env.LOG_ROOT || '/var/log';
const PM2_LOG_DIR = process.env.PM2_LOG_DIR || '/home/ubuntu/.pm2/logs';
const APP_DIR = process.env.APP_DIR || '/home/ubuntu/chumbaq';
const APP_USER = process.env.APP_USER || 'ubuntu';
/** Directories under LOG_ROOT taken whole (by date), and top-level log families. */
const LOG_DIRS = ['nginx', 'postgresql', 'redis', 'chrony'];
const LOG_FAMILIES = /^(auth\.log|syslog|kern\.log|dpkg\.log)(\b|$)/;
/** Never packed, whatever directory they turn up in. */
const SECRET = /(^|\/)\.env|\.(pem|key)$/;

function fail(message) {
  console.error(message);
  process.exit(2);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function time(name) {
  const value = arg(name);
  const date = value && /^\d{4}-\d{2}-\d{2}T/.test(value) ? new Date(value) : new Date(NaN);
  if (Number.isNaN(date.getTime())) fail(`${name} must be an ISO 8601 time, such as 2026-11-11T08:00:00Z`);
  return date;
}

const from = time('--from');
const to = time('--to');
if (from >= to) fail('--from must be before --to');
const stamp = (d) => d.toISOString().replace(/\.\d{3}Z$/, 'Z');
const compact = (d) => stamp(d).replace(/[-:]/g, '');
const ymd = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
// A rotated file is named for the day it was rotated, so a day either side is kept.
const firstDay = ymd(new Date(from.getTime() - DAY));
const lastDay = ymd(new Date(to.getTime() + DAY));

/** In the window: a dated file by its date (YYYYMMDD in the name), an undated one by when it last changed. */
function wanted(file) {
  if (SECRET.test(file)) return false;
  const dated = /(?:-|__)(\d{8})(?:\D|$)/.exec(path.basename(file));
  if (dated) return dated[1] >= firstDay && dated[1] <= lastDay;
  return statSync(file).mtimeMs >= from.getTime() - DAY;
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? walk(p) : e.isFile() ? [p] : [];
  });
}

const name = `chumbaq-logs-${compact(from)}-${compact(to)}`;
// A root-only directory (deploy-setup.sh makes it 0700), never a shared one such as /var/tmp.
const outDir = arg('--out') || '/var/lib/chumbaq/log-bundles';
mkdirSync(outDir, { recursive: true, mode: 0o700 });
if (process.getuid?.() === 0) {
  const st = statSync(outDir);
  if (st.uid !== 0 || (st.mode & 0o022) !== 0) fail(`${outDir} must be owned by root and writable only by root`);
}
const archive = path.join(outDir, `${name}.tar.gz`);
if (existsSync(archive)) fail(`${archive} already exists; move it away first`);
// The work happens in a private directory with a random name, never at a guessable path.
const work = mkdtempSync(path.join(outDir, '.collect-'));
const top = path.join(work, name);
mkdirSync(top, { mode: 0o700 });

const packed = [];
function take(source, rel) {
  const dest = path.join(top, rel);
  mkdirSync(path.dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  packed.push(rel);
}

for (const dir of LOG_DIRS) {
  for (const file of walk(path.join(LOG_ROOT, dir)).filter(wanted)) take(file, path.join('var-log', path.relative(LOG_ROOT, file)));
}
for (const entry of existsSync(LOG_ROOT) ? readdirSync(LOG_ROOT, { withFileTypes: true }) : []) {
  const file = path.join(LOG_ROOT, entry.name);
  if (entry.isFile() && LOG_FAMILIES.test(entry.name) && wanted(file)) take(file, path.join('var-log', entry.name));
}
for (const file of walk(PM2_LOG_DIR).filter(wanted)) take(file, path.join('pm2', path.basename(file)));

// The database's log tables, written by the app user (it holds the database settings).
const dbDir = path.join(top, 'database');
mkdirSync(dbDir, { recursive: true });
let exportCommand;
let exported;
if (process.env.DB_EXPORT_CMD) {
  exportCommand = process.env.DB_EXPORT_CMD;
  exported = spawnSync('bash', ['-c', `${process.env.DB_EXPORT_CMD} "$1"`, 'db-export', dbDir], { encoding: 'utf8' });
} else {
  if (process.getuid?.() === 0) {
    const ids = spawnSync('id', ['-u', APP_USER], { encoding: 'utf8' });
    const gids = spawnSync('id', ['-g', APP_USER], { encoding: 'utf8' });
    chownSync(dbDir, Number(ids.stdout), Number(gids.stdout));
    // The app user writes its CSVs into database/, so it may pass through (not list) these.
    chmodSync(work, 0o711);
    chmodSync(top, 0o711);
  }
  exportCommand = `npm run --silent security:export-db-logs -w apps/api -- --from ${stamp(from)} --to ${stamp(to)} --out ${dbDir}`;
  exported = spawnSync('sudo', ['-u', APP_USER, '-H', 'bash', '-c', `cd "${APP_DIR}" && ${exportCommand}`], { encoding: 'utf8' });
}
if (exported.status !== 0) {
  console.error(`The database export failed; the files are packed without it.\n${exported.stderr ?? ''}`);
}
for (const file of walk(dbDir)) packed.push(path.relative(top, file));

const clock = spawnSync('chronyc', ['-c', 'tracking'], { encoding: 'utf8', timeout: 2000 });
const sha = (rel) => createHash('sha256').update(readFileSync(path.join(top, rel))).digest('hex');
const manifest = [
  `Chumbaq log bundle`,
  `Host: ${hostname()}`,
  `Window: ${stamp(from)} to ${stamp(to)} (files dated ${firstDay} to ${lastDay}, and current files changed since ${stamp(new Date(from.getTime() - DAY))})`,
  `Collected: ${stamp(new Date())}`,
  `Command: collect-logs.sh ${process.argv.slice(2).join(' ')}`,
  `Database export: ${exportCommand} (${exported.status === 0 ? 'ok' : 'failed'})`,
  `Clock: ${clock.status === 0 ? clock.stdout.trim() : 'chronyc unavailable'}`,
  '',
  'SHA-256',
  ...packed.sort().map((rel) => `${sha(rel)}  ${rel}`),
  '',
].join('\n');
writeFileSync(path.join(top, 'MANIFEST.txt'), manifest, { mode: 0o600 });

// Written inside the private directory, then moved into place.
const built = path.join(work, `${name}.tar.gz`);
const tar = spawnSync('tar', ['-czf', built, '-C', work, name], { encoding: 'utf8' });
if (tar.status !== 0) fail(`tar failed: ${tar.stderr}`);
chmodSync(built, 0o600);
renameSync(built, archive);
rmSync(work, { recursive: true, force: true });
console.log(archive);
