import { Logger } from '@nestjs/common';
import { ClockCheckScheduler } from './clock-check.scheduler';

describe('ClockCheckScheduler', () => {
  const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  beforeEach(() => warn.mockClear());

  it('logs a clock more than a second off, or with no source', async () => {
    await new ClockCheckScheduler().check(async () => ({ state: 'bad', source: 'samay1.nic.in', stratum: 2, offsetMs: 1500 }));
    expect(warn).toHaveBeenCalledWith('Clock offset 1500 ms from samay1.nic.in');
    await new ClockCheckScheduler().check(async () => ({ state: 'bad', source: null, stratum: 0, offsetMs: 0 }));
    expect(warn).toHaveBeenLastCalledWith('Clock is not synchronised to any time source');
  });

  it('is quiet when the clock is fine or chrony is absent', async () => {
    await new ClockCheckScheduler().check(async () => ({ state: 'warn', source: 'x', stratum: 2, offsetMs: 200 }));
    await new ClockCheckScheduler().check(async () => ({ state: 'unknown', source: null, stratum: null, offsetMs: null }));
    expect(warn).not.toHaveBeenCalled();
  });
});
