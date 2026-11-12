import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface PlatformEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export type PlatformEmailResult =
  | { sent: true }
  | { sent: false; reason: 'not_configured' | 'refused' | 'unreachable' };

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const TIMEOUT_MS = 10_000;

/**
 * Chumbaq's own account email: verification, password resets, security notices.
 * Only these. Campaigns always go through the tenant's own provider, so nothing a
 * tenant sends can ever affect this sender's reputation, and the reverse.
 *
 * Optional, so a self-hosted deployment can boot without it. Callers must handle
 * `sent: false`, because a link that never arrived cannot be treated as delivered.
 */
@Injectable()
export class PlatformEmailService {
  private readonly logger = new Logger(PlatformEmailService.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string | undefined {
    return this.config.get<string>('PLATFORM_BREVO_API_KEY') || undefined;
  }

  /** The address mail comes from, or null if either setting is missing or unusable. */
  get sender(): { name?: string; email: string } | null {
    const from = this.config.get<string>('PLATFORM_EMAIL_FROM')?.trim();
    if (!this.apiKey || !from) return null;
    const named = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(from);
    if (named) {
      const name = named[1].trim();
      return name ? { name, email: named[2] } : { email: named[2] };
    }
    return /^[^<>\s]+@[^<>\s]+$/.test(from) ? { email: from } : null;
  }

  get isConfigured(): boolean {
    return this.sender !== null;
  }

  /** Never throws, and never logs the body: it holds reset links and codes. */
  async send(email: PlatformEmail): Promise<PlatformEmailResult> {
    const sender = this.sender;
    if (!sender) {
      this.logger.warn('Account email not sent: PLATFORM_BREVO_API_KEY or PLATFORM_EMAIL_FROM is not set');
      return { sent: false, reason: 'not_configured' };
    }

    try {
      const response = await fetch(BREVO_URL, {
        method: 'POST',
        headers: {
          'api-key': this.apiKey as string,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          sender,
          to: [{ email: email.to }],
          subject: email.subject,
          htmlContent: email.html,
          textContent: email.text,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (response.ok) return { sent: true };

      // Brevo's error code and message only: enough to diagnose a bad key or an
      // unverified sender, and they hold nothing from the email.
      const body = (await response.json().catch(() => null)) as {
        code?: string;
        message?: string;
      } | null;
      this.logger.error(
        `Brevo refused account email: ${response.status} ${body?.code ?? ''} ${body?.message ?? ''}`,
      );
      return { sent: false, reason: 'refused' };
    } catch (error) {
      this.logger.error(`Could not reach Brevo: ${(error as Error).name}`);
      return { sent: false, reason: 'unreachable' };
    }
  }
}
