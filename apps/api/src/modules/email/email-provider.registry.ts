import { BadRequestException, Injectable } from '@nestjs/common';
import { EmailProviderName } from '../push-notifications/message-channel';
import { EmailProvider } from './providers/email-provider';
import { ResendProvider } from './providers/resend.provider';
import { SesProvider } from './providers/ses.provider';
import { BrevoProvider } from './providers/brevo.provider';

/** The email providers this build can send through. */
@Injectable()
export class EmailProviderRegistry {
  private readonly providers = new Map<EmailProviderName, EmailProvider>();

  constructor(ses: SesProvider, resend: ResendProvider, brevo: BrevoProvider) {
    this.providers.set(ses.provider, ses);
    this.providers.set(resend.provider, resend);
    this.providers.set(brevo.provider, brevo);
  }

  get(name: EmailProviderName): EmailProvider {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new BadRequestException(`No email provider named "${name}" in this build.`);
    }
    return provider;
  }
}
