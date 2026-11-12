import { BadRequestException, Logger } from '@nestjs/common';
import {
  ChannelRecipient,
  ChannelSendOptions,
  ChannelSendResult,
  DeliveryProvider,
} from './channel-provider';
import { SendOutcome, runPool, summariseOutcomes } from './channel-send';

/**
 * A problem with the account rather than with one recipient: a revoked key, a
 * suspended account, a sender the account may not use. It stops the page —
 * every remaining recipient would fail the same way — and is reported as
 * retryable so none of them is marked as given up on. The worker then fails the attempt with this as the reason,
 * and the campaign resumes from the checkpoint once the account is fixed and
 * the job retried.
 */
export class ProviderAccountError extends Error {}

export interface AttemptResult {
  outcome: SendOutcome;
  /** Server-requested delay before trying again, when it named one. */
  retryAfterMs?: number;
}

const MAX_RETRY_AFTER_MS = 30_000;

/**
 * Longest one request to an email, SMS or WhatsApp provider may take, body
 * included. Without it a provider that stops answering holds a send lane (or
 * a settings save) until the socket dies. A send that times out is retried
 * like any network error: the provider may or may not have taken it.
 */
export const PROVIDER_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Whether an error means the provider could not be reached or did not answer
 * in time, rather than that it answered. Node's fetch rejects with a
 * `TypeError('fetch failed')` for DNS, connection and TLS failures, and the
 * time limit's signal with a `TimeoutError` (`AbortError` for a plain abort).
 * Anything else, a bug of ours included, is not this. Checked by name, not
 * `instanceof`: the timeout is a `DOMException`, which need not share the
 * `Error` of the code checking it (it does not under Jest).
 */
export function isUnreachableError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  if (name === 'TimeoutError' || name === 'AbortError') return true;
  return name === 'TypeError' && message === 'fetch failed';
}

/**
 * Runs a dashboard-facing call to a provider (a credentials check, a template
 * list), turning "could not reach it" into a 400 the person can act on. The
 * raw error says nothing useful to them and can carry internal detail (an
 * address, a socket error), so none of it is shown.
 */
export async function reachProvider<T>(label: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (isUnreachableError(error)) {
      throw new BadRequestException(`Could not reach ${label}. Try again.`);
    }
    throw error;
  }
}

/**
 * What every provider that sends one HTTP request per recipient shares —
 * the email services and Twilio: per-recipient retries with backoff, a
 * bounded pool, and the resolved-prefix accounting the worker checkpoints on.
 *
 * None of them takes a list of individually personalised messages in one
 * call, so a page is sent one recipient at a time.
 */
export abstract class PerRecipientProvider<TMessage, TName extends string>
  implements DeliveryProvider<TMessage, TName>
{
  abstract readonly provider: TName;
  protected abstract readonly logger: Logger;
  /** Requests in flight at once. Kept under each service's default rate. */
  protected abstract readonly concurrency: number;
  protected readonly maxAttempts: number = 3;
  /** Overridable so tests need not wait the real limit. */
  protected readonly requestTimeoutMs: number = PROVIDER_REQUEST_TIMEOUT_MS;

  /**
   * `fetch` with the time limit, which also covers reading the body. Every
   * request a provider makes goes through here.
   */
  protected request(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, { ...init, signal: AbortSignal.timeout(this.requestTimeoutMs) });
  }

  /** Parses and checks stored credentials; throws when they are unusable. */
  protected abstract parseCredentials(credentials: unknown): unknown;

  protected abstract attempt(
    credentials: unknown,
    to: string,
    message: TMessage,
  ): Promise<AttemptResult>;

  abstract validateCredentials(credentials: unknown): Promise<void>;

  async sendToRecipients(
    credentials: unknown,
    recipients: ChannelRecipient<TMessage>[],
    _options?: ChannelSendOptions,
  ): Promise<ChannelSendResult> {
    const tokens = recipients.map((recipient) => recipient.token);
    if (recipients.length === 0) return summariseOutcomes([], []);

    const parsed = this.parseCredentials(credentials);
    const outcomes: SendOutcome[] = new Array(recipients.length);
    let accountError: string | null = null;

    // Lanes are not cancelled when one hits an account error; they check the
    // flag before starting each recipient instead. Throwing out of the pool
    // would abandon sends still in flight in other lanes, which then land
    // with nothing recording them, and the resume would send them again.
    await runPool(recipients.length, this.concurrency, async (index) => {
      if (accountError) {
        outcomes[index] = { kind: 'retryable', error: accountError };
        return;
      }
      const { token, message } = recipients[index];
      try {
        outcomes[index] = await this.sendWithRetry(parsed, token, message);
      } catch (error) {
        if (!(error instanceof ProviderAccountError)) throw error;
        accountError = error.message;
        outcomes[index] = { kind: 'retryable', error: error.message };
      }
    });

    return summariseOutcomes(tokens, outcomes, this.logger, this.provider);
  }

  private async sendWithRetry(
    credentials: unknown,
    to: string,
    message: TMessage,
  ): Promise<SendOutcome> {
    let last: SendOutcome = { kind: 'retryable', error: 'not attempted' };

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      let result: AttemptResult;
      try {
        result = await this.attempt(credentials, to, message);
      } catch (error) {
        if (error instanceof ProviderAccountError) throw error;
        // A network failure, not an answer: the provider may or may not have
        // taken the message, and trying again is the only way to find out.
        result = {
          outcome: {
            kind: 'retryable',
            error: error instanceof Error ? error.message : 'Network error',
          },
        };
      }

      last = result.outcome;
      if (last.kind !== 'retryable') return last;
      if (attempt < this.maxAttempts) {
        await this.sleep(this.retryDelayMs(attempt, result.retryAfterMs));
      }
    }

    return last;
  }

  /** Exponential backoff with jitter. Overridable so tests are not paced. */
  protected retryDelayMs(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, MAX_RETRY_AFTER_MS);
    }
    return 500 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250);
  }

  protected sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  protected parseRetryAfter(header: string | null): number | undefined {
    if (!header) return undefined;
    const seconds = Number(header);
    return Number.isFinite(seconds) ? seconds * 1000 : undefined;
  }
}

/** Reads a JSON body without letting a non-JSON error page throw. */
export async function readJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : { message: text };
  } catch {
    return { message: text.slice(0, 500) };
  }
}
