import { ChildProcess, spawn, spawnSync } from 'child_process';
import { createWriteStream, mkdirSync } from 'fs';
import http from 'http';
import https from 'https';
import net from 'net';
import path from 'path';
import { LOG_DIR } from './stack';

/**
 * Starting and stopping the stack's processes. Each runs in its own process group
 * (`detached`), so stopping signals the whole tree (npx → vite, and so on) and a child
 * reparented on the way down is still caught. Output goes to e2e/.artefacts/logs/<name>.log.
 */

export interface Started {
  name: string;
  child: ChildProcess;
  log: string;
}

export function run(name: string, command: string, args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Started {
  mkdirSync(LOG_DIR, { recursive: true });
  const log = path.join(LOG_DIR, `${name}.log`);
  const out = createWriteStream(log, { flags: 'w' });
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.pipe(out);
  child.stderr?.pipe(out);
  return { name, child, log };
}

/** Runs a command to completion, failing loudly with its output if it fails. */
export function runToEnd(label: string, command: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, args, { cwd, env: env ?? process.env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`${label} failed (exit ${result.status}):\n${(result.stdout ?? '').slice(-4000)}\n${(result.stderr ?? '').slice(-4000)}`);
  }
}

const GRACE_MS = 5000;

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** TERM to every group, then KILL to any still alive after the grace period. */
export async function stopAll(started: Started[]): Promise<void> {
  const pids = started.map((s) => s.child.pid).filter((pid): pid is number => typeof pid === 'number');
  for (const pid of pids) {
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      // Already gone.
    }
  }
  const deadline = Date.now() + GRACE_MS;
  while (Date.now() < deadline && pids.some(groupAlive)) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  for (const pid of pids) {
    if (groupAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
  }
}

export function portInUse(port: number): Promise<boolean> {
  const tryHost = (host: string) =>
    new Promise<boolean>((resolve) => {
      const socket = net.connect({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
  return Promise.all([tryHost('127.0.0.1'), tryHost('::1')]).then((answers) => answers.some(Boolean));
}

function get(url: string): Promise<number> {
  return new Promise((resolve) => {
    const client = url.startsWith('https:') ? https : http;
    const req = client.get(url, { rejectUnauthorized: false, timeout: 2000 }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', () => resolve(0));
    req.on('timeout', () => {
      req.destroy();
      resolve(0);
    });
  });
}

/**
 * Waits until `url` answers 2xx, or fails with the tail of the process's log if it
 * exits first or the time runs out.
 */
export async function waitForUrl(started: Started, url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let exited: number | null = null;
  started.child.once('exit', (code) => (exited = code ?? -1));
  while (Date.now() < deadline) {
    if (exited !== null) throw new Error(`${started.name} exited (${exited}) before ${url} answered; see ${started.log}`);
    const status = await get(url);
    if (status >= 200 && status < 300) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${started.name} did not answer ${url} within ${timeoutMs / 1000}s; see ${started.log}`);
}

/** Waits for a line in the process's output (for the worker, which has no port). */
export function waitForOutput(started: Started, pattern: RegExp, timeoutMs = 120_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`${started.name} did not print ${pattern} within ${timeoutMs / 1000}s; see ${started.log}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      seen = (seen + chunk.toString()).slice(-8192);
      if (pattern.test(seen)) {
        cleanup();
        resolve();
      }
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`${started.name} exited (${code}) before it was ready; see ${started.log}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      started.child.stdout?.off('data', onData);
      started.child.off('exit', onExit);
    };
    started.child.stdout?.on('data', onData);
    started.child.once('exit', onExit);
  });
}
