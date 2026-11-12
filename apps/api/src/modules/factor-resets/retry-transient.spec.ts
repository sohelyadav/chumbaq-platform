import { QueryFailedError } from 'typeorm';
import { isTransientDbError, retryTransient } from './retry-transient';

const pgError = (code: string) =>
  new QueryFailedError('SELECT 1', [], Object.assign(new Error(`pg ${code}`), { code }));

describe('retryTransient', () => {
  it.each(['40001', '40P01', '55P03', '57014', '08006'])('retries %s and returns the result', async (code) => {
    const work = jest.fn().mockRejectedValueOnce(pgError(code)).mockResolvedValue('done');
    await expect(retryTransient(work, { baseDelayMs: 0 })).resolves.toBe('done');
    expect(work).toHaveBeenCalledTimes(2);
  });

  it('gives up after the last attempt with the last error', async () => {
    const last = pgError('40P01');
    const work = jest.fn().mockRejectedValueOnce(pgError('40P01')).mockRejectedValueOnce(pgError('40001')).mockRejectedValue(last);
    await expect(retryTransient(work, { baseDelayMs: 0 })).rejects.toBe(last);
    expect(work).toHaveBeenCalledTimes(3);
  });

  it('does not retry an error that would only happen again', async () => {
    const unique = pgError('23505');
    const work = jest.fn().mockRejectedValue(unique);
    await expect(retryTransient(work, { baseDelayMs: 0 })).rejects.toBe(unique);
    expect(work).toHaveBeenCalledTimes(1);
    expect(isTransientDbError(new Error('no code'))).toBe(false);
  });
});
