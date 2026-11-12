import retentionConfig, { activityLogRetentionDays, authEventRetentionDays } from './retention.config';

describe('authEventRetentionDays', () => {
  it('keeps a year when unset or blank', () => {
    expect(authEventRetentionDays(undefined)).toBe(365);
    expect(authEventRetentionDays('')).toBe(365);
    expect(authEventRetentionDays('  ')).toBe(365);
  });

  it.each([
    ['180', 180],
    ['400', 400],
    [' 730 ', 730],
  ])('reads %p', (value, expected) => {
    expect(authEventRetentionDays(value)).toBe(expected);
  });

  it.each(['179', '90', '0', '-365'])('refuses %p, below the 180 days CERT-In requires', (value) => {
    expect(() => authEventRetentionDays(value)).toThrow(/at least 180/);
  });

  it.each(['abc', '365d', '200.5', '1e3'])('refuses %p, which is not a whole number of days', (value) => {
    expect(() => authEventRetentionDays(value)).toThrow(/whole number of days/);
  });
});

describe('activityLogRetentionDays', () => {
  it('keeps a year when unset or blank', () => {
    expect(activityLogRetentionDays(undefined)).toBe(365);
    expect(activityLogRetentionDays('')).toBe(365);
    expect(activityLogRetentionDays('  ')).toBe(365);
  });

  it.each([
    ['180', 180],
    ['400', 400],
    [' 730 ', 730],
  ])('reads %p', (value, expected) => {
    expect(activityLogRetentionDays(value)).toBe(expected);
  });

  it('refuses a value below the 180 days CERT-In requires, naming its own variable', () => {
    expect(() => activityLogRetentionDays('179')).toThrow(
      new Error('ACTIVITY_LOG_RETENTION_DAYS must be at least 180 (CERT-In requires 180 days of logs), not 179'),
    );
  });

  it.each(['90', '0', '-365'])('refuses %p, below the floor', (value) => {
    expect(() => activityLogRetentionDays(value)).toThrow(/^ACTIVITY_LOG_RETENTION_DAYS must be at least 180/);
  });

  it('refuses a value that is not a whole number of days, naming its own variable', () => {
    expect(() => activityLogRetentionDays('abc')).toThrow(
      new Error('ACTIVITY_LOG_RETENTION_DAYS must be a whole number of days, not "abc"'),
    );
  });

  it.each(['365d', '200.5', '1e3'])('refuses %p, which is not a whole number of days', (value) => {
    expect(() => activityLogRetentionDays(value)).toThrow(/^ACTIVITY_LOG_RETENTION_DAYS must be a whole number/);
  });
});

describe('retention config', () => {
  const KEYS = ['AUTH_EVENT_RETENTION_DAYS', 'ACTIVITY_LOG_RETENTION_DAYS'] as const;
  const load = (values: Partial<Record<(typeof KEYS)[number], string>>) => {
    const saved = KEYS.map((key) => [key, process.env[key]] as const);
    for (const key of KEYS) {
      if (values[key] === undefined) delete process.env[key];
      else process.env[key] = values[key];
    }
    try {
      return (retentionConfig as unknown as () => Record<string, unknown>)();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('reads AUTH_EVENT_RETENTION_DAYS and ACTIVITY_LOG_RETENTION_DAYS', () => {
    expect(load({ AUTH_EVENT_RETENTION_DAYS: '500', ACTIVITY_LOG_RETENTION_DAYS: '200' })).toEqual({
      authEventDays: 500,
      activityLogDays: 200,
    });
    expect(load({})).toEqual({ authEventDays: 365, activityLogDays: 365 });
  });

  it('fails start-up on a value below the floor', () => {
    expect(() => load({ AUTH_EVENT_RETENTION_DAYS: '30' })).toThrow(/AUTH_EVENT_RETENTION_DAYS/);
    expect(() => load({ ACTIVITY_LOG_RETENTION_DAYS: '30' })).toThrow(/ACTIVITY_LOG_RETENTION_DAYS/);
  });
});
