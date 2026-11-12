/**
 * Postgres errors that say nothing about the work itself, only that this attempt lost:
 * serialization failure, deadlock, lock timeout, a cancelled statement, the server
 * going away. Class 08 is every connection failure.
 */
const TRANSIENT_CODES = new Set(['40001', '40P01', '55P03', '57014', '57P01', '57P02', '57P03']);

export function isTransientDbError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && (TRANSIENT_CODES.has(code) || code.startsWith('08'));
}

/**
 * Runs `work` up to `attempts` times while it fails with a transient error, waiting a
 * little longer each time. Anything else, or the last failure, is thrown as it came.
 * `work` must be a whole transaction, so a retry starts clean.
 */
export async function retryTransient<T>(
  work: () => Promise<T>,
  { attempts = 3, baseDelayMs = 25 }: { attempts?: number; baseDelayMs?: number } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await work();
    } catch (error) {
      if (attempt >= attempts || !isTransientDbError(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, baseDelayMs * 4 ** (attempt - 1)));
    }
  }
}
