import { addDays, addMonths, dayStart, monthEnd, monthStart, utcDay } from './usage-days';

describe('usage days', () => {
  it('names the UTC day of an instant, whatever the local zone', () => {
    expect(utcDay(new Date('2026-11-13T23:59:59Z'))).toBe('2026-11-13');
    expect(utcDay(new Date('2026-11-14T00:00:00Z'))).toBe('2026-11-14');
    // 01:30 on the 14th in India is still the 13th in UTC.
    expect(utcDay(new Date('2026-11-14T01:30:00+05:30'))).toBe('2026-11-13');
  });

  it('adds days across month and year ends', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-11-14', -90)).toBe('2026-08-16');
    expect(addDays('2026-11-14', 0)).toBe('2026-11-14');
  });

  it('starts a day at UTC midnight', () => {
    expect(dayStart('2026-11-14').toISOString()).toBe('2026-11-14T00:00:00.000Z');
  });

  it('names the first day of the month', () => {
    expect(monthStart('2026-11-14')).toBe('2026-11-01');
    expect(monthStart('2026-11-01')).toBe('2026-11-01');
  });

  it('moves by whole months from the first of a month', () => {
    expect(addMonths('2026-11-14', -1)).toBe('2026-10-01');
    expect(addMonths('2026-01-31', -1)).toBe('2025-12-01');
    expect(addMonths('2026-12-01', 1)).toBe('2027-01-01');
    expect(addMonths('2026-11-01', -13)).toBe('2025-10-01');
  });

  it('names the last day of the month', () => {
    expect(monthEnd('2026-02-10')).toBe('2026-02-28');
    expect(monthEnd('2028-02-01')).toBe('2028-02-29');
    expect(monthEnd('2026-10-31')).toBe('2026-10-31');
    expect(monthEnd('2026-12-05')).toBe('2026-12-31');
  });

  it('refuses anything but a YYYY-MM-DD day', () => {
    expect(() => dayStart('2026-11-14T00:00:00Z')).toThrow();
    expect(() => addDays('2026-02-30', 1)).toThrow();
  });
});
