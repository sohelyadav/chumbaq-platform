import { ConfigService } from '@nestjs/config';
import { effectiveSeatLimit } from './seats.service';

// Counting and the limit check run against Postgres in seats.int-spec.ts.
describe('effectiveSeatLimit', () => {
  it('is no limit when nothing is set', () => {
    expect(effectiveSeatLimit(null)).toBeNull();
    expect(effectiveSeatLimit(undefined, new ConfigService({ projects: { maxSeatsPerAccount: null } }))).toBeNull();
  });

  it('uses the environment limit when the account has no override', () => {
    expect(effectiveSeatLimit(null, new ConfigService({ projects: { maxSeatsPerAccount: 5 } }))).toBe(5);
  });

  it('prefers the staff override, including zero', () => {
    const config = new ConfigService({ projects: { maxSeatsPerAccount: 5 } });
    expect(effectiveSeatLimit(12, config)).toBe(12);
    expect(effectiveSeatLimit(0, config)).toBe(0);
  });

  it('lets staff give a seat limit to an install that has none', () => {
    expect(effectiveSeatLimit(3, new ConfigService({ projects: { maxSeatsPerAccount: null } }))).toBe(3);
  });
});
