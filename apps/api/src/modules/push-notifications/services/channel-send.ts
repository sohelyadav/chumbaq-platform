import { Logger } from '@nestjs/common';
import { logValue } from '../../../common/log-value';
import { ChannelFailure, ChannelSendResult } from './channel-provider';

/**
 * What happened to one recipient.
 *
 * `retryable` is the load-bearing case: the send did not succeed and has not
 * been given up on, so the caller must not record progress past it.
 */
export type SendOutcome =
  | { kind: 'success' }
  | { kind: 'permanent'; error: string; errorCode?: string }
  | { kind: 'retryable'; error: string };

/**
 * Turns per-recipient outcomes into the result the campaign worker checkpoints
 * against.
 *
 * Shared rather than reimplemented per provider, because this is the part a
 * provider can get subtly wrong with no visible symptom until a campaign
 * silently skips people. The worker advances its cursor by `resolvedCount`, so
 * the prefix must stop at the first recipient still worth retrying — every
 * one after it is left for the next attempt even if it happened to succeed,
 * since the cursor cannot express a gap.
 */
export function summariseOutcomes(
  tokens: string[],
  outcomes: SendOutcome[],
  logger?: Logger,
  channelName = 'channel',
): ChannelSendResult {
  let resolvedCount = 0;
  let retryReason: string | null = null;

  while (resolvedCount < outcomes.length) {
    const outcome = outcomes[resolvedCount];
    if (outcome.kind === 'retryable') {
      retryReason = outcome.error;
      break;
    }
    resolvedCount++;
  }

  const failures: ChannelFailure[] = [];
  let successCount = 0;

  for (let i = 0; i < resolvedCount; i++) {
    const outcome = outcomes[i];
    if (outcome.kind === 'success') {
      successCount++;
    } else if (outcome.kind === 'permanent') {
      failures.push({
        token: tokens[i],
        error: outcome.error,
        errorCode: outcome.errorCode,
        retryable: false,
      });
    }
  }

  if (retryReason && logger) {
    logger.warn(
      // The reason can carry text from the provider's reply.
      `${channelName} page stopped after ${resolvedCount}/${tokens.length} tokens: ${logValue(retryReason)}`,
    );
  }

  return {
    successCount,
    failureCount: failures.length,
    failures,
    resolvedCount,
    retryReason,
  };
}

/**
 * Runs `worker` over `count` indices with at most `concurrency` in flight.
 *
 * Every channel needs this: firing a whole page at once is what provokes the
 * rate limiting that loses recipients, and none of these APIs take a batch.
 */
export async function runPool(
  count: number,
  concurrency: number,
  worker: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(concurrency, count) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= count) return;
      await worker(index);
    }
  });
  await Promise.all(lanes);
}
