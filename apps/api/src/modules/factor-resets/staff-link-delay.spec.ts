import { STAFF_LINK_USABLE_FOR_MS, staffLinkDelayMs } from './staff-link-delay';

const HOUR_MS = 60 * 60 * 1000;

describe('staffLinkDelayMs', () => {
  it('waits 24 hours when unset or blank', () => {
    expect(staffLinkDelayMs(undefined)).toBe(24 * HOUR_MS);
    expect(staffLinkDelayMs(' ')).toBe(24 * HOUR_MS);
  });

  it('takes hours from 1 up, including fractions', () => {
    expect(staffLinkDelayMs('1')).toBe(HOUR_MS);
    expect(staffLinkDelayMs('36.5')).toBe(36.5 * HOUR_MS);
  });

  // Under an hour would leave the owner no real time to see the notice and sign in.
  it.each(['0', '0.5', '-24', 'abc', '24h', 'Infinity'])('refuses %p rather than shortening the wait', (raw) => {
    expect(() => staffLinkDelayMs(raw)).toThrow('STAFF_LINK_DELAY_HOURS');
  });

  it('keeps the link usable for 24 hours once the wait is over', () => {
    expect(STAFF_LINK_USABLE_FOR_MS).toBe(24 * HOUR_MS);
  });
});
