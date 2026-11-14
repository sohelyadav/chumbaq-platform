import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { logValue } from '../../common/log-value';
import { ConsentEventsService } from '../consent/consent-events.service';
import { escapeHtml, renderEmail } from './email-rendering';
import { EmailProviderRegistry } from './email-provider.registry';
import { EmailSettingsService } from './email-settings.service';
import { EmailUnsubscribeService } from './email-unsubscribe.service';
import { CONFIRM_KEY_PURPOSE, UnsubscribeLinks } from './unsubscribe-link';

/** Confirmation mails one tick sends at most, and per project, so one project cannot take every slot. */
export const CONFIRMATIONS_PER_TICK = 100;
export const CONFIRMATIONS_PER_PROJECT_PER_TICK = 20;
/** A pending address is mailed again after this long, never sooner. */
const RESEND_AFTER = '7 days';

/**
 * Double opt-in for email. While a project requires opt-in (the default), an email
 * opt-in reported through identify counts only once whoever holds the address confirms
 * it from a link mailed there, through the project's own provider: anyone holding the
 * app's public key can report an opt-in for any address. Confirming marks every row
 * holding the address in the project, so the holder's own word outweighs any earlier
 * refusal reported for it.
 */
@Injectable()
export class EmailConfirmationsService {
  private readonly logger = new Logger(EmailConfirmationsService.name);
  private readonly links: UnsubscribeLinks;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly settings: EmailSettingsService,
    private readonly registry: EmailProviderRegistry,
    private readonly unsubscribe: EmailUnsubscribeService,
    private readonly consentEvents: ConsentEventsService,
    crypto: CredentialsCryptoService,
    config: ConfigService,
  ) {
    this.links = new UnsubscribeLinks(
      crypto.deriveKey(CONFIRM_KEY_PURPOSE),
      String(config.get('app.baseUrl') ?? ''),
      '/api/email/confirm',
    );
  }

  url(projectId: string, address: string): string {
    return this.links.url(projectId, address);
  }

  /** The address a confirmation link was signed for, or null. */
  verify(projectId: unknown, encodedAddress: unknown, signature: unknown): string | null {
    return this.links.verify(projectId, encodedAddress, signature);
  }

  /** Records the holder's confirmation for every row holding the address. Returns how many. */
  async confirm(projectId: string, address: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string }> = await manager.query(
        `SELECT id FROM device_identities WHERE project_id = $1 AND email = $2 ORDER BY id FOR UPDATE`,
        [projectId, address],
      );
      if (rows.length === 0) return 0;
      await manager.query(
        `UPDATE device_identities
            SET email_confirmed_at = COALESCE(email_confirmed_at, now()), email_opt_in = true, consent_updated_at = now()
          WHERE project_id = $1 AND email = $2`,
        [projectId, address],
      );
      await this.consentEvents.recordForAddress(projectId, 'email', address, true, 'email_confirmation', manager);
      return rows.length;
    });
  }

  /**
   * Mails the confirmation to addresses that opted in and are not confirmed yet, in
   * projects that require opt-in and have a provider connected. Each address is claimed
   * with one conditional UPDATE before it is mailed, so two workers never mail it twice,
   * and is mailed again only after `RESEND_AFTER`. Returns how many were sent.
   */
  async sendPending(): Promise<number> {
    const due: Array<{ project_id: string; email: string }> = await this.dataSource.query(
      `SELECT project_id, email FROM (
         SELECT d.project_id, d.email,
                row_number() OVER (PARTITION BY d.project_id ORDER BY d.email) AS n
           FROM device_identities d
           JOIN email_settings s ON s.project_id = d.project_id
           JOIN projects p ON p.id = d.project_id
           JOIN users o ON o.id = p.owner_id
          WHERE s.require_opt_in AND s.provider IS NOT NULL AND o.suspended_at IS NULL
            AND d.email IS NOT NULL AND d.email_opt_in = true AND d.email_confirmed_at IS NULL
            AND (d.email_confirm_sent_at IS NULL OR d.email_confirm_sent_at < now() - interval '${RESEND_AFTER}')
            AND NOT EXISTS (
              SELECT 1 FROM channel_suppressions x
               WHERE x.project_id = d.project_id AND x.channel = 'email' AND x.address = d.email)
          GROUP BY d.project_id, d.email
       ) pending
       WHERE n <= $1
       LIMIT $2`,
      [CONFIRMATIONS_PER_PROJECT_PER_TICK, CONFIRMATIONS_PER_TICK],
    );

    let sent = 0;
    for (const { project_id: projectId, email } of due) {
      const claimed: unknown[] = await this.dataSource.query(
        `UPDATE device_identities SET email_confirm_sent_at = now()
          WHERE project_id = $1 AND email = $2 AND email_confirmed_at IS NULL
            AND (email_confirm_sent_at IS NULL OR email_confirm_sent_at < now() - interval '${RESEND_AFTER}')
          RETURNING id`,
        [projectId, email],
      );
      if (claimed.length === 0) continue;
      try {
        if (await this.mail(projectId, email)) sent++;
      } catch (error) {
        this.logger.warn(`Confirmation not sent for a project ${projectId} address: ${logValue((error as Error).message)}`);
      }
    }
    return sent;
  }

  private async mail(projectId: string, address: string): Promise<boolean> {
    const { settings, credentials } = await this.settings.requireSendable(projectId);
    const link = this.url(projectId, address);
    const from = settings.fromName || settings.fromEmail;
    const message = renderEmail({
      content: {
        subject: `Confirm you want emails from ${from}`,
        html: `<p>Please confirm that you want to receive emails from ${escapeHtml(from)} at this address.</p>
<p><a href="${escapeHtml(link)}">Yes, send me emails</a></p>
<p>If you did not ask for this, ignore this email and you will not be sent any.</p>`,
        text: `Please confirm that you want to receive emails from ${from} at this address.\n\nYes, send me emails: ${link}\n\nIf you did not ask for this, ignore this email and you will not be sent any.`,
        preheader: null,
      },
      identity: null,
      sender: settings,
      unsubscribeUrl: this.unsubscribe.url(projectId, address),
      tags: {},
    });
    const result = await this.registry.get(settings.provider).sendToRecipients(credentials, [{ token: address, message }]);
    return result.successCount === 1;
  }
}
