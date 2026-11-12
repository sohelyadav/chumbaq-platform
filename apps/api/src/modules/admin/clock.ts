import { execFile } from 'child_process';
import type { AdminClock } from '@chumbaq/shared';

export const CLOCK_WARN_MS = 100;
export const CLOCK_BAD_MS = 1000;
const CHRONYC_TIMEOUT_MS = 2000;

export interface ChronyTracking {
  source: string | null;
  stratum: number;
  offsetMs: number;
}

/**
 * `chronyc -c tracking`: comma-separated, field 0 the reference id (hex), 1 its name,
 * 2 the stratum, 4 the system clock's offset in seconds (signed). A reference id of all
 * zeros, or stratum 0, means chrony has no source.
 */
export function parseChronyTracking(output: string): ChronyTracking {
  const fields = output.trim().split('\n')[0]?.split(',') ?? [];
  const stratum = Number(fields[2]);
  const offset = Number(fields[4]);
  if (fields.length < 5 || !/^[0-9A-Fa-f]{8}$/.test(fields[0]) || !Number.isFinite(stratum) || !Number.isFinite(offset)) {
    throw new Error('Unrecognised chronyc output');
  }
  const synced = fields[0] !== '00000000' && stratum > 0;
  return {
    source: synced ? fields[1] || fields[0] : null,
    stratum,
    offsetMs: Math.round(Math.abs(offset) * 1e9) / 1e6,
  };
}

export function clockState(t: ChronyTracking): AdminClock['state'] {
  if (!t.source || t.offsetMs > CLOCK_BAD_MS) return 'bad';
  return t.offsetMs > CLOCK_WARN_MS ? 'warn' : 'ok';
}

type ExecFile = (
  file: string,
  args: string[],
  options: { timeout: number },
  callback: (error: Error | null, stdout: string) => void,
) => unknown;

/** Never throws: no chrony, a timeout, or odd output is `unknown`. Fixed arguments, no shell. */
export function readClock(exec: ExecFile = execFile as unknown as ExecFile): Promise<AdminClock> {
  const unknown: AdminClock = { state: 'unknown', source: null, stratum: null, offsetMs: null };
  return new Promise((resolve) => {
    exec('chronyc', ['-c', 'tracking'], { timeout: CHRONYC_TIMEOUT_MS }, (error, stdout) => {
      if (error) return resolve(unknown);
      try {
        const tracking = parseChronyTracking(String(stdout));
        resolve({ state: clockState(tracking), ...tracking });
      } catch {
        resolve(unknown);
      }
    });
  });
}
