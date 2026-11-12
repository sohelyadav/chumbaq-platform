import { BadRequestException, Injectable } from '@nestjs/common';
import { WhatsAppProviderName } from '../push-notifications/message-channel';
import { WhatsAppProvider } from './providers/whatsapp-provider';
import { MetaWhatsAppProvider } from './providers/meta.provider';
import { TwilioWhatsAppProvider } from './providers/twilio-whatsapp.provider';
import { GupshupProvider } from './providers/gupshup.provider';
import { InteraktProvider } from './providers/interakt.provider';

/** The WhatsApp providers this build can send through. */
@Injectable()
export class WhatsAppProviderRegistry {
  private readonly providers = new Map<WhatsAppProviderName, WhatsAppProvider>();

  constructor(
    meta: MetaWhatsAppProvider,
    twilio: TwilioWhatsAppProvider,
    gupshup: GupshupProvider,
    interakt: InteraktProvider,
  ) {
    for (const provider of [meta, twilio, gupshup, interakt]) {
      this.providers.set(provider.provider, provider);
    }
  }

  get(name: WhatsAppProviderName): WhatsAppProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new BadRequestException(`No WhatsApp provider named "${name}" in this build.`);
    }
    return provider;
  }
}
