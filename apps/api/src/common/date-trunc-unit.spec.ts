import { DATE_TRUNC_UNITS, dateTruncUnit } from './date-trunc-unit';

describe('dateTruncUnit', () => {
  it.each(DATE_TRUNC_UNITS)('passes %s through', (unit) => {
    expect(dateTruncUnit(unit)).toBe(unit);
  });

  // Values a query string can actually carry: anything, an empty string, a
  // repeated parameter (an array), or nothing at all.
  it.each<[unknown]>([
    ["day') || (SELECT 'x') || ('"],
    ['month'],
    ['DAY'],
    [' day'],
    [''],
    [['day']],
    [['hour', 'day']],
    [undefined],
    [null],
    [{ toString: () => 'day' }],
  ])('replaces %j with the default', (value) => {
    expect(dateTruncUnit(value)).toBe('day');
  });

  it('uses the given fallback', () => {
    expect(dateTruncUnit('month', 'week')).toBe('week');
  });
});
