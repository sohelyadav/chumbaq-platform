import {
  Controller,
  ForbiddenException,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { RawBodyRequest } from '@nestjs/common/interfaces';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import {
  WHATSAPP_PROVIDERS,
  WhatsAppProviderName,
} from '../push-notifications/message-channel';
import { WhatsAppSettingsService } from './whatsapp-settings.service';
import { WhatsAppEventsService } from './whatsapp-events.service';
import { WhatsAppProviderRegistry } from './whatsapp-provider.registry';
import { WebhookRequest } from './providers/whatsapp-provider';

const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Provider webhooks: delivery reports, replies and opt-outs. Each is found
 * by the secret token in its URL and then authenticated by the provider's
 * own signature where it has one (Meta, Twilio, Interakt); Gupshup's are
 * unsigned and so corroborated before they can change anything.
 */
@Controller('whatsapp')
export class WhatsAppPublicController {
  private readonly logger = new Logger(WhatsAppPublicController.name);

  constructor(
    private readonly settings: WhatsAppSettingsService,
    private readonly events: WhatsAppEventsService,
    private readonly registry: WhatsAppProviderRegistry,
  ) {}

  /**
   * Meta's subscription handshake: echo `hub.challenge` when the verify
   * token is the one shown in settings (the webhook token itself).
   */
  @SkipThrottle()
  @Get('webhooks/meta/:token')
  async verifyMeta(
    @Param('token') token: string,
    @Query('hub.mode') mode: string,
    @Query('hub.verify_token') verifyToken: string,
    @Query('hub.challenge') challenge: string,
    @Res() res: Response,
  ): Promise<void> {
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings || mode !== 'subscribe' || verifyToken !== settings.webhookToken) {
      throw new ForbiddenException();
    }
    res.status(200).type('text/plain').send(String(challenge ?? ''));
  }

  // Not throttled: providers report a campaign in bursts from few addresses,
  // and a dropped report is a lost opt-out.
  @SkipThrottle()
  @Post('webhooks/:provider/:token')
  async receive(
    @Param('provider') providerName: string,
    @Param('token') token: string,
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
  ): Promise<void> {
    if (!(WHATSAPP_PROVIDERS as readonly string[]).includes(providerName)) throw new NotFoundException();
    const name = providerName as WhatsAppProviderName;
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings) throw new NotFoundException();

    const credentials = await this.settings.credentialsFor(settings.projectId, name);
    if (!credentials) {
      throw new ForbiddenException(`Connect ${name} in WhatsApp settings to receive its webhooks.`);
    }

    const provider = this.registry.get(name);
    const request: WebhookRequest = {
      // As the provider called it: the public base URL, not this server's
      // own idea of its address behind a proxy. Twilio signs this.
      url: `${this.settings.baseUrl()}${req.originalUrl}`,
      rawBody: req.rawBody?.toString('utf8') ?? '',
      body: req.body,
      query: req.query as Record<string, unknown>,
      header: (headerName) => req.header(headerName),
    };

    const authenticated = provider.authenticateWebhook(credentials, request);
    if (authenticated === false) throw new UnauthorizedException('Signature did not verify.');

    const recorded = await this.events.ingest(
      settings.projectId,
      name,
      provider.parseWebhook(request),
      provider.suppressingErrors,
      { signed: authenticated === true, attributeByRecency: !provider.reportsCarryCampaign },
    );
    if (recorded > 0) this.logger.debug(`Recorded ${recorded} WhatsApp event(s) for ${settings.projectId}`);

    if (name === 'twilio_whatsapp') {
      res.status(200).type('text/xml').send(EMPTY_TWIML);
      return;
    }
    res.status(200).json({ recorded });
  }
}
