import projectsConfig, { maxProjectsPerAccount, maxSeatsPerAccount } from './projects.config';

describe('maxProjectsPerAccount', () => {
  it('is 10 when unset or blank', () => {
    expect(maxProjectsPerAccount(undefined)).toBe(10);
    expect(maxProjectsPerAccount('')).toBe(10);
    expect(maxProjectsPerAccount('  ')).toBe(10);
  });

  it.each([
    ['1', 1],
    ['25', 25],
    [' 50 ', 50],
  ])('reads %p', (value, expected) => {
    expect(maxProjectsPerAccount(value)).toBe(expected);
  });

  it.each(['0', '-1', 'ten', '2.5', '1e3', 'unlimited'])('refuses %p', (value) => {
    expect(() => maxProjectsPerAccount(value)).toThrow(/MAX_PROJECTS_PER_ACCOUNT/);
  });

  it('is what the config namespace gives', () => {
    const saved = process.env.MAX_PROJECTS_PER_ACCOUNT;
    try {
      process.env.MAX_PROJECTS_PER_ACCOUNT = '7';
      expect(projectsConfig().maxPerAccount).toBe(7);
      delete process.env.MAX_PROJECTS_PER_ACCOUNT;
      expect(projectsConfig().maxPerAccount).toBe(10);
    } finally {
      if (saved === undefined) delete process.env.MAX_PROJECTS_PER_ACCOUNT;
      else process.env.MAX_PROJECTS_PER_ACCOUNT = saved;
    }
  });
});

describe('maxSeatsPerAccount', () => {
  it('is no limit when unset or blank', () => {
    expect(maxSeatsPerAccount(undefined)).toBeNull();
    expect(maxSeatsPerAccount('')).toBeNull();
    expect(maxSeatsPerAccount(' ')).toBeNull();
  });

  it.each([
    ['1', 1],
    ['5', 5],
    [' 20 ', 20],
  ])('reads %p', (value, expected) => {
    expect(maxSeatsPerAccount(value)).toBe(expected);
  });

  it.each(['0', '-1', '2.5', 'ten'])('refuses %p', (value) => {
    expect(() => maxSeatsPerAccount(value)).toThrow(
      `MAX_SEATS_PER_ACCOUNT must be a whole number of at least 1, not "${value}"`,
    );
  });

  it('is registered as projects.maxSeatsPerAccount', () => {
    const saved = process.env.MAX_SEATS_PER_ACCOUNT;
    try {
      process.env.MAX_SEATS_PER_ACCOUNT = '4';
      expect(projectsConfig().maxSeatsPerAccount).toBe(4);
      delete process.env.MAX_SEATS_PER_ACCOUNT;
      expect(projectsConfig().maxSeatsPerAccount).toBeNull();
    } finally {
      if (saved === undefined) delete process.env.MAX_SEATS_PER_ACCOUNT;
      else process.env.MAX_SEATS_PER_ACCOUNT = saved;
    }
  });
});
