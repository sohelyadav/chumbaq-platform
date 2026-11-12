import { clockState, parseChronyTracking, readClock } from './clock';

const line = (refId: string, name: string, stratum: number, offset: string) =>
  `${refId},${name},${stratum},1794236500.123456789,${offset},0.000023,0.000045,-5.123,0.001,0.010,0.000123,0.000456,64.5,Normal\n`;

describe('clock', () => {
  it('reads the source, stratum and offset from chronyc -c tracking', () => {
    expect(parseChronyTracking(line('A4FFFF7A', 'samay1.nic.in', 2, '0.000012345'))).toEqual({
      source: 'samay1.nic.in',
      stratum: 2,
      offsetMs: 0.012345,
    });
    expect(parseChronyTracking(line('0E8B3C67', 'time.nplindia.org', 1, '-0.250000000')).offsetMs).toBe(250);
  });

  it('has no source when chrony is not synchronised', () => {
    expect(parseChronyTracking(line('00000000', '', 0, '0.000000000')).source).toBeNull();
  });

  it('refuses output it does not understand', () => {
    expect(() => parseChronyTracking('nonsense')).toThrow();
  });

  it('grades the clock: ok to 100 ms, warn to 1 s, bad beyond or with no source', () => {
    expect(clockState({ source: 'samay1.nic.in', stratum: 2, offsetMs: 100 })).toBe('ok');
    expect(clockState({ source: 'samay1.nic.in', stratum: 2, offsetMs: 101 })).toBe('warn');
    expect(clockState({ source: 'samay1.nic.in', stratum: 2, offsetMs: 1001 })).toBe('bad');
    expect(clockState({ source: null, stratum: 0, offsetMs: 0 })).toBe('bad');
  });

  it('runs chronyc with fixed arguments and a 2-second limit', async () => {
    const exec = jest.fn((_cmd: string, _args: string[], _opts: object, cb: (e: Error | null, out: string) => void) =>
      cb(null, line('A4FFFF7A', 'samay2.nic.in', 2, '0.050000000')),
    );
    await expect(readClock(exec as never)).resolves.toEqual({ state: 'ok', source: 'samay2.nic.in', stratum: 2, offsetMs: 50 });
    expect(exec).toHaveBeenCalledWith('chronyc', ['-c', 'tracking'], { timeout: 2000 }, expect.any(Function));
  });

  it('is unknown where chrony is not installed or does not answer', async () => {
    const missing = (_c: string, _a: string[], _o: object, cb: (e: Error | null, out: string) => void) =>
      cb(Object.assign(new Error('spawn chronyc ENOENT'), { code: 'ENOENT' }), '');
    await expect(readClock(missing as never)).resolves.toEqual({ state: 'unknown', source: null, stratum: null, offsetMs: null });
  });
});
