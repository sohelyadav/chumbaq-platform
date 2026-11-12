import {
  Controller,
  ForbiddenException,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { SmsSettingsService } from './sms-settings.service';
import { SmsEventsService } from './sms-events.service';
import { SmsSettingsEntity } from './entities/sms-settings.entity';
import {
  parseInboundKeyword,
  parseTwilioStatus,
  verifyTwilioSignature,
} from './twilio-webhooks';

/** An empty TwiML reply: no answer from Chumbaq, so Twilio's own STOP/START confirmations stand. */
const EMPTY_TWIML = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

/**
 * Twilio's webhooks: per-message delivery reports, and replies to the
 * sender. Each is authenticated by a secret URL plus Twilio's signature,
 * checked with the Auth Token stored for the project.
 */
@Controller('sms')
export class SmsPublicController {
  private readonly logger = new Logger(SmsPublicController.name);

  constructor(
    private readonly settings: SmsSettingsService,
    private readonly events: SmsEventsService,
  ) {}

  // Not throttled: Twilio reports a campaign's deliveries in a burst from a
  // few addresses, and a throttled report is a lost STOP or a lost bounce.
  @SkipThrottle()
  @Post('webhooks/twilio/:token/status')
  @HttpCode(204)
  async status(@Param('token') token: string, @Req() req: Request): Promise<void> {
    const settings = await this.authenticate(token, req);
    const event = parseTwilioStatus(req.body ?? {}, req.query as Record<string, unknown>);
    if (event) await this.events.ingest(settings.projectId, 'twilio', event);
  }

  @SkipThrottle()
  @Post('webhooks/twilio/:token/inbound')
  async inbound(
    @Param('token') token: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const settings = await this.authenticate(token, req);
    const keyword = parseInboundKeyword(req.body ?? {});
    if (keyword) {
      await this.events.keyword(settings.projectId, 'twilio', keyword.action, keyword.address);
      this.logger.log(`Recorded an SMS ${keyword.action} for project ${settings.projectId}`);
    }
    res.status(200).type('text/xml').send(EMPTY_TWIML);
  }

  /**
   * Finds the project by its token, then proves Twilio sent the request.
   *
   * The signed URL is rebuilt from the public base URL rather than read off
   * the request: behind a TLS-terminating proxy the request believes it
   * arrived over http on an internal host, and the signature would never
   * match.
   */
  private async authenticate(token: string, req: Request): Promise<SmsSettingsEntity> {
    const settings = await this.settings.findByWebhookToken(token);
    if (!settings) throw new NotFoundException();

    const credentials = await this.settings.credentialsFor(settings.projectId, 'twilio');
    const authToken = credentials?.authToken;
    if (typeof authToken !== 'string') {
      throw new ForbiddenException('Connect Twilio in SMS settings to receive its webhooks.');
    }

    const params = (req.body ?? {}) as Record<string, unknown>;
    const url = `${this.settings.baseUrl()}${req.originalUrl}`;
    if (!verifyTwilioSignature(authToken, url, params, req.header('x-twilio-signature'))) {
      throw new UnauthorizedException('Signature did not verify.');
    }
    // A valid signature from a different Twilio account that shares the
    // token cannot happen by accident; checked anyway, because it is free.
    if (params.AccountSid && params.AccountSid !== credentials?.accountSid) {
      throw new ForbiddenException('This request is for a different Twilio account.');
    }
    return settings;
  }
}
