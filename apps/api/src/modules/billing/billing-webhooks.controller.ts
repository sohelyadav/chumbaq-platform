import { Controller, Headers, HttpCode, Post, RawBodyRequest, Req, Res, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { BillingEnabledGuard } from './billing-enabled.guard';
import { BillingWebhooksService } from './billing-webhooks.service';

/**
 * The billing provider's webhook. Public: the signature over the raw body is the
 * authentication. It reads `req.rawBody` and never `@Body()`, so no validation pipe
 * runs on it and the bytes checked are the bytes sent.
 *
 * Throttled per address rather than skipped: the provider sends from few addresses,
 * and a refused request costs one HMAC.
 */
@Controller('billing/webhooks')
@UseGuards(BillingEnabledGuard)
export class BillingWebhooksController {
  constructor(private readonly webhooks: BillingWebhooksService) {}

  @Post('razorpay')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 600 } })
  async razorpay(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-razorpay-signature') signature: string | undefined,
    @Headers('x-razorpay-event-id') eventId: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.webhooks.receive(req.rawBody, signature, eventId);
    res.status(result.status);
    return result.body;
  }
}
