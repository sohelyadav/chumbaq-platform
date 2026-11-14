import { ConfigService } from '@nestjs/config';
import type { DataSource, EntityManager } from 'typeorm';
import { AccountLimitsService } from '../billing/account-limits.service';
import { UserEntity } from '../users/entities/user.entity';
import { SeatsService } from './seats.service';

const OWNER = '6b0c1f8e-2f3a-4c55-9a1e-7d2c9b4e0a11';

/** A manager holding one `users` row, matched only by its id, as the table would. */
function withOwner(seatLimit: number | null): EntityManager {
  return {
    findOne: async (entity: unknown, options: { where: { id?: string } }) =>
      entity === UserEntity && options.where.id === OWNER ? { id: OWNER, projectLimit: null, seatLimit } : null,
  } as unknown as EntityManager;
}

function seats(maxSeatsPerAccount: number | null): SeatsService {
  return new SeatsService(
    {} as DataSource,
    new AccountLimitsService(new ConfigService({ projects: { maxSeatsPerAccount } })),
  );
}

// With billing off. Counting and the limit check run against Postgres in seats.int-spec.ts,
// and the billing-on limits in plan-limits.int-spec.ts.
describe('SeatsService.seatLimitOf', () => {
  it('is no limit when nothing is set', async () => {
    expect(await seats(null).seatLimitOf(withOwner(null), OWNER)).toBeNull();
  });

  it('uses the environment limit when the account has no override', async () => {
    expect(await seats(5).seatLimitOf(withOwner(null), OWNER)).toBe(5);
  });

  it('prefers the staff override, including zero', async () => {
    expect(await seats(5).seatLimitOf(withOwner(12), OWNER)).toBe(12);
    expect(await seats(5).seatLimitOf(withOwner(0), OWNER)).toBe(0);
  });

  it('lets staff give a seat limit to an install that has none', async () => {
    expect(await seats(null).seatLimitOf(withOwner(3), OWNER)).toBe(3);
  });

  it('gives an account it cannot find the environment limit', async () => {
    expect(await seats(5).seatLimitOf(withOwner(3), '00000000-0000-4000-8000-000000000000')).toBe(5);
  });
});
