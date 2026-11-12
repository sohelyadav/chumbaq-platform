import { ERASE_ATTEMPTS, PersonErasureService, isRetryable, retryDelayMs } from './person-erasure.service';

const CTX = { ipAddress: null, userAgent: null };

describe('PersonErasureService retries', () => {
  const pgError = (code: string) => Object.assign(new Error(code), { driverError: { code } });

  it('recognises Postgres deadlocks and serialization failures, and nothing else', () => {
    expect(isRetryable(pgError('40P01'))).toBe(true);
    expect(isRetryable(pgError('40001'))).toBe(true);
    expect(isRetryable({ code: '40P01' })).toBe(true);
    expect(isRetryable(pgError('23505'))).toBe(false);
    expect(isRetryable(new Error('boom'))).toBe(false);
  });

  it('waits 50 to 200 ms between tries', () => {
    expect(retryDelayMs(() => 0)).toBe(50);
    expect(retryDelayMs(() => 0.999999)).toBe(200);
  });

  it('runs the whole transaction again after a deadlock, up to the limit', async () => {
    jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      fn();
      return 0 as never;
    }) as never);
    const service = new PersonErasureService({} as never, {} as never, {} as never, { record: async () => undefined } as never);
    const once = jest
      .spyOn(service as unknown as { eraseOnce: () => Promise<unknown> }, 'eraseOnce')
      .mockRejectedValueOnce(pgError('40P01'))
      .mockResolvedValueOnce({ result: 'erased' });
    await expect(service.erase('p', { type: 'externalUserId', value: 'u' }, { type: 'user', id: 'x' }, CTX)).resolves.toEqual({
      result: 'erased',
    });
    expect(once).toHaveBeenCalledTimes(2);

    once.mockReset().mockRejectedValue(pgError('40001'));
    await expect(service.erase('p', { type: 'externalUserId', value: 'u' }, { type: 'user', id: 'x' }, CTX)).rejects.toThrow('40001');
    expect(once).toHaveBeenCalledTimes(ERASE_ATTEMPTS);

    once.mockReset().mockRejectedValue(pgError('23505'));
    await expect(service.erase('p', { type: 'externalUserId', value: 'u' }, { type: 'user', id: 'x' }, CTX)).rejects.toThrow('23505');
    expect(once).toHaveBeenCalledTimes(1);
  });
});
