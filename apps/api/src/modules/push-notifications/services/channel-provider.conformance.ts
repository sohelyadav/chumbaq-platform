import {
  DeliveryProvider,
  ChannelRecipient,
  CampaignMessage,
} from './channel-provider';

/**
 * The contract every channel must satisfy, as an executable suite.
 *
 * A provider is not just "something that sends". The campaign worker
 * checkpoints its progress against `resolvedCount` after every page, so a
 * provider that overstates what it finished causes recipients to be skipped
 * with nothing left to retry them — silently, and only under load. That is not
 * a property a code review reliably catches, so each provider is made to
 * demonstrate it instead.
 *
 * A new provider adds one call to this from its own spec:
 *
 *   describeChannelProviderConformance(
 *     'MiPushProvider',
 *     () => new MiPushProvider(...),
 *     { credentials: fakeCredentials },
 *   );
 */
export interface ConformanceContext<TMessage = CampaignMessage> {
  /** Credentials the provider should accept as well-formed. */
  credentials: unknown;
  /**
   * Puts the provider in a state where a send resolves everything it was
   * given. Providers reach the network differently, so each supplies its own.
   *
   * Required, not optional. Without it the send tests below would exercise a
   * provider that cannot reach anything, and a conformance run that passes
   * because nothing was actually sent proves nothing at all.
   */
  stubAllDelivered: (recipients: ChannelRecipient<TMessage>[]) => void;
  /**
   * Builds a page of recipients in this channel's message shape. Defaults to
   * push messages addressed to `tok-<i>`; a non-push channel supplies its own.
   */
  makeRecipients?: (count: number) => ChannelRecipient<TMessage>[];
}

export function makeMessage(over: Partial<CampaignMessage> = {}): CampaignMessage {
  return { title: 'Hello', body: 'World', campaignId: 'camp-1', ...over };
}

export function makeRecipients(count: number): ChannelRecipient[] {
  return Array.from({ length: count }, (_, i) => ({
    token: `tok-${i}`,
    message: makeMessage(),
  }));
}

export function describeChannelProviderConformance<
  TMessage = CampaignMessage,
>(
  name: string,
  build: () => DeliveryProvider<TMessage>,
  context: ConformanceContext<TMessage>,
): void {
  const recipientsOf = (count: number): ChannelRecipient<TMessage>[] =>
    context.makeRecipients
      ? context.makeRecipients(count)
      : (makeRecipients(count) as unknown as ChannelRecipient<TMessage>[]);

  describe(`${name} — ChannelProvider conformance`, () => {
    let provider: DeliveryProvider<TMessage>;

    beforeEach(() => {
      provider = build();
    });

    it('names the channel it delivers on', () => {
      // The registry keys on this, so a provider that reports the wrong
      // channel would be handed other channels' tokens.
      expect(typeof provider.provider).toBe('string');
      expect(provider.provider.length).toBeGreaterThan(0);
    });

    it('accepts an empty page without contacting anything', async () => {
      const result = await provider.sendToRecipients(context.credentials, []);

      expect(result).toMatchObject({
        successCount: 0,
        failureCount: 0,
        resolvedCount: 0,
      });
      expect(result.failures).toEqual([]);
    });

    it('never reports more resolved than it was given', async () => {
      const recipients = recipientsOf(3);
      context.stubAllDelivered(recipients);

      const result = await provider.sendToRecipients(
        context.credentials,
        recipients,
      );

      // The worker advances its cursor by this number. Overstating it skips
      // recipients permanently; they are not retried, because as far as the
      // campaign is concerned they are done.
      expect(result.resolvedCount).toBeLessThanOrEqual(recipients.length);
      expect(result.resolvedCount).toBeGreaterThanOrEqual(0);
    });

    it('accounts for every resolved recipient exactly once', async () => {
      const recipients = recipientsOf(3);
      context.stubAllDelivered(recipients);

      const result = await provider.sendToRecipients(
        context.credentials,
        recipients,
      );

      // Successes plus failures must equal the resolved prefix. A gap means a
      // recipient was neither delivered nor recorded as failed, and nothing
      // downstream can tell that they were dropped.
      expect(result.successCount + result.failureCount).toBe(
        result.resolvedCount,
      );
    });

    it('gives a reason whenever it stops short', async () => {
      const recipients = recipientsOf(3);
      context.stubAllDelivered(recipients);

      const result = await provider.sendToRecipients(
        context.credentials,
        recipients,
      );

      // An unexplained short resolve is indistinguishable from a bug, and the
      // worker logs this reason when it re-queues the remainder.
      if (result.resolvedCount < recipients.length) {
        expect(result.retryReason).toBeTruthy();
      } else {
        expect(result.retryReason).toBeNull();
      }
    });

    it('reports failures against the token that failed', async () => {
      const recipients = recipientsOf(3);
      context.stubAllDelivered(recipients);

      const result = await provider.sendToRecipients(
        context.credentials,
        recipients,
      );

      const tokens = new Set(recipients.map((r) => r.token));
      for (const failure of result.failures) {
        // Deactivation and the reachability figures both key off this token.
        // A failure attributed to the wrong one disables a live device.
        expect(tokens.has(failure.token)).toBe(true);
        expect(failure.retryable).toBe(false);
      }
    });

    it('rejects credentials it cannot use', async () => {
      // Rejected when pasted, rather than discovered by a campaign that
      // reaches nobody.
      await expect(
        provider.validateCredentials({ nonsense: true }),
      ).rejects.toThrow();
    });
  });
}
