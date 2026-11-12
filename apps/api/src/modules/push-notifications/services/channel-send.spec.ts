import { Logger } from '@nestjs/common';
import { summariseOutcomes } from './channel-send';

describe('summariseOutcomes', () => {
  it('logs a retry reason quoted, so a provider reply cannot forge log lines', () => {
    // Reasons can carry text from a provider's reply, which this server does
    // not control.
    const logger = { warn: jest.fn() } as unknown as Logger;
    summariseOutcomes(
      ['t1', 't2'],
      [{ kind: 'success' }, { kind: 'retryable', error: 'busy\n[Nest] ERROR forged' }],
      logger,
      'FCM',
    );

    const line = (logger.warn as jest.Mock).mock.calls[0][0] as string;
    expect(line).not.toContain('\n');
    expect(line).toBe('FCM page stopped after 1/2 tokens: "busy\\n[Nest] ERROR forged"');
  });
});
