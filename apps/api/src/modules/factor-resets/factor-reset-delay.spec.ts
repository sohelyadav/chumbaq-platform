import { factorResetDelayMs } from './factor-reset-delay';

const HOUR_MS = 60 * 60 * 1000;

describe('factorResetDelayMs', () => {
  it('waits 72 hours when unset or blank', () => {
    expect(factorResetDelayMs(undefined)).toBe(72 * HOUR_MS);
    expect(factorResetDelayMs('  ')).toBe(72 * HOUR_MS);
  });

  it('takes hours, including fractions', () => {
    expect(factorResetDelayMs('24')).toBe(24 * HOUR_MS);
    expect(factorResetDelayMs('0.5')).toBe(HOUR_MS / 2);
  });

  it.each(['0', '-1', 'abc', '72h', 'Infinity'])('refuses %p rather than resetting at once', (raw) => {
    expect(() => factorResetDelayMs(raw)).toThrow('FACTOR_RESET_DELAY_HOURS');
  });
});
