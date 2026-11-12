import { BadRequestException, Injectable } from '@nestjs/common';
import { SmsProviderName } from '../push-notifications/message-channel';
import { SmsProvider, TwilioProvider } from './providers/twilio.provider';

/** The SMS providers this build can send through. */
@Injectable()
export class SmsProviderRegistry {
  private readonly providers = new Map<SmsProviderName, SmsProvider>();

  constructor(twilio: TwilioProvider) {
    this.providers.set(twilio.provider, twilio);
  }

  get(name: SmsProviderName): SmsProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new BadRequestException(`No SMS provider named "${name}" in this build.`);
    }
    return provider;
  }
}
