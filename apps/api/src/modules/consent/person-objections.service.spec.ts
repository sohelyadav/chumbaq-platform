import { ConflictException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { PersonObjectionsService } from './person-objections.service';

/**
 * The one race the row locks leave open (a device claiming the id that
 * arrives and is erased between the lock and the history insert) cannot be
 * staged deterministically against Postgres, so its mapping is pinned here:
 * the driver error Postgres raises for it, 23503, must reach the caller as a
 * 409, and nothing else may be swallowed.
 */
describe('PersonObjectionsService error mapping', () => {
  const driverError = (code: string) =>
    new QueryFailedError('INSERT ...', [], Object.assign(new Error('violation'), { code }));

  const serviceFailingWith = (error: unknown) =>
    new PersonObjectionsService(
      null as never,
      { manager: { transaction: jest.fn().mockRejectedValue(error) } } as never,
      null as never,
      { record: async () => undefined } as never,
    );

  it('answers a foreign key violation with 409, for create and lift', async () => {
    const service = serviceFailingWith(driverError('23503'));
    await expect(service.object('p', 'asha', { userId: 'u' }, null)).rejects.toBeInstanceOf(ConflictException);
    await expect(service.lift('p', 'asha', null)).rejects.toBeInstanceOf(ConflictException);
  });

  it('answers a deadlock or serialization failure with 409, not a 500', async () => {
    for (const code of ['40P01', '40001']) {
      await expect(
        serviceFailingWith(driverError(code)).object('p', 'asha', { userId: 'u' }, null),
      ).rejects.toBeInstanceOf(ConflictException);
    }
  });

  it('leaves any other database error alone', async () => {
    const other = driverError('23505');
    await expect(serviceFailingWith(other).object('p', 'asha', { userId: 'u' }, null)).rejects.toBe(other);
  });
});
