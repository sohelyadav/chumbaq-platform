import { Logger } from '@nestjs/common';
import type { BillingLedgerService } from './billing-ledger.service';
import { BillingWebhooksService, REFUSAL_LOG_INTERVAL_MS } from './billing-webhooks.service';
import type { BillingProvider } from './providers/billing-provider';

describe('BillingWebhooksService refusals', () => {
  afterEach(() => jest.restoreAllMocks());

  it('logs a refused webhook at most once a minute, counting the rest into the next line', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const provider = { verifyWebhook: () => false } as unknown as BillingProvider;
    const ledger = {} as BillingLedgerService;
    const service = new BillingWebhooksService(ledger, provider);
    const t0 = new Date('2026-11-14T10:00:00Z');
    const at = (ms: number) => new Date(t0.getTime() + ms);

    for (let i = 0; i < 50; i++) {
      expect((await service.receive(Buffer.from('{}'), 'bad', 'evt_1', at(i * 100))).status).toBe(400);
    }
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toBe('Refused a billing webhook: missing body or signature did not verify');

    await service.receive(Buffer.from('{}'), 'bad', 'evt_1', at(REFUSAL_LOG_INTERVAL_MS));
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[1][0]).toBe(
      'Refused a billing webhook: missing body or signature did not verify (and 49 more refused since the last line)',
    );
  });
});
