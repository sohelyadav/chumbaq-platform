import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { createHmac } from 'crypto';
import { domainToASCII } from 'url';
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
/** A pending address is mailed again after this long, never sooner; a link works this long. */
const RESEND_AFTER = '7 days';
const LINK_LIFETIME_MS = 7 * 24 * 60 * 60 * 1000;
/** Confirmations one project mails in a day at most, whoever reports the opt-ins. */
export const CONFIRMATIONS_PER_PROJECT_PER_DAY = 500;
const SENDS_KEY_PURPOSE = 'chumbaq/email-confirm-sends/v1';

/**
 * Double opt-in for email. While a project requires opt-in (the default), an email
 * opt-in reported through identify counts only once whoever holds the address confirms
 * it from a link mailed there, through the project's own provider: anyone holding the
 * app's public key can report an opt-in for any address. Confirming marks every row
 * holding the address in the project, so the holder's own word outweighs any earlier
 * refusal reported for it.
 */
/**
 * The inbox an address reaches, for the send limit: `+tags` lead to the same inbox,
 * and Gmail ignores dots and treats googlemail.com as gmail.com, so each spelling of one
 * inbox must count as one.
 */
export function mailboxOf(address: string): string {
  const at = address.lastIndexOf('@');
  if (at < 1) return address.toLowerCase();
  let local = address.slice(0, at).toLowerCase();
  // One spelling of the domain: no trailing dots, internationalised names as punycode.
  let domain = domainToASCII(address.slice(at + 1).toLowerCase().replace(/\.+$/, '')) || address.slice(at + 1).toLowerCase();
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'googlemail.com') domain = 'gmail.com';
  if (domain === 'gmail.com') local = local.replace(/\./g, '');
  return `${local}@${domain}`;
}

@Injectable()
export class EmailConfirmationsService {
  private readonly logger = new Logger(EmailConfirmationsService.name);
  private readonly links: UnsubscribeLinks;
  private readonly sendsKey: Buffer;

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
    this.sendsKey = crypto.deriveKey(SENDS_KEY_PURPOSE);
  }

  /** The link for one send: it names the send's time, and works only for that send, for a week. */
  url(projectId: string, address: string, sentAt: Date): string {
    return this.links.url(projectId, `${address}\n${sentAt.getTime()}`);
  }

  /** The address and send a confirmation link was signed for, or null (forged or expired). */
  verify(projectId: unknown, encoded: unknown, signature: unknown): { address: string; sentAt: Date } | null {
    const signed = this.links.verify(projectId, encoded, signature);
    if (!signed) return null;
    const cut = signed.lastIndexOf('\n');
    const sentAtMs = Number(signed.slice(cut + 1));
    if (cut < 1 || !Number.isFinite(sentAtMs) || Date.now() - sentAtMs > LINK_LIFETIME_MS) return null;
    return { address: signed.slice(0, cut), sentAt: new Date(sentAtMs) };
  }

  /**
   * Records the holder's confirmation, if the link is for the address's latest send and
   * it is still pending. Every row holding the address is marked, except one that
   * refused after the link was sent: a later refusal outweighs an older link (and keeps
   * the address out, since any refusal does). Returns how many rows were confirmed.
   */
  async confirm(projectId: string, address: string, sentAt: Date): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string; sent: boolean }> = await manager.query(
        `SELECT id, date_trunc('milliseconds', email_confirm_sent_at) = $3::timestamptz AS sent
           FROM device_identities WHERE project_id = $1 AND email = $2 ORDER BY id FOR UPDATE`,
        [projectId, address, sentAt],
      );
      if (!rows.some((row) => row.sent)) return 0;
      const result: unknown = await manager.query(
        `UPDATE device_identities
            SET email_confirmed_at = COALESCE(email_confirmed_at, now()), email_opt_in = true, consent_updated_at = now()
          WHERE project_id = $1 AND email = $2
            AND (email_opt_in IS DISTINCT FROM false OR consent_updated_at IS NULL OR consent_updated_at <= $3::timestamptz)
          RETURNING id`,
        [projectId, address, sentAt],
      );
      // pg answers an UPDATE ... RETURNING as [rows, count].
      const confirmed = Array.isArray(result) && Array.isArray(result[0]) ? (result[0] as unknown[]).length : 0;
      if (confirmed > 0) {
        await this.consentEvents.recordForAddress(projectId, 'email', address, true, 'email_confirmation', manager);
      }
      return confirmed;
    });
  }

  /**
   * Mails the confirmation to addresses that opted in and are not confirmed yet, in
   * projects that require opt-in and have a provider connected. An address is claimed
   * in `email_confirmation_sends`, per address and atomically, so it is mailed at most
   * once a week however its rows are made or changed, and two workers never mail it
   * twice; a project mails at most `CONFIRMATIONS_PER_PROJECT_PER_DAY`. Returns how many
   * were sent.
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
            -- A project at its daily cap waits for tomorrow and takes no one's turn.
            AND (SELECT count(*) FROM email_confirmation_sends c
                  WHERE c.project_id = d.project_id AND c.last_sent_at > now() - interval '1 day') < $3
          GROUP BY d.project_id, d.email
       ) pending
       WHERE n <= $1
       ORDER BY n, project_id
       LIMIT $2`,
      [CONFIRMATIONS_PER_PROJECT_PER_TICK, CONFIRMATIONS_PER_TICK, CONFIRMATIONS_PER_PROJECT_PER_DAY],
    );

    let sent = 0;
    for (const { project_id: projectId, email } of due) {
      const sentAt = await this.claim(projectId, email);
      if (!sentAt) continue;
      try {
        if (await this.mail(projectId, email, sentAt)) sent++;
      } catch (error) {
        this.logger.warn(`Confirmation not sent for a project ${projectId} address: ${logValue((error as Error).message)}`);
      }
    }
    return sent;
  }

  /** The send's time if this address may be mailed now (and is now marked), else null. */
  private async claim(projectId: string, address: string): Promise<Date | null> {
    return this.dataSource.transaction(async (manager) => {
      const [{ today }] = await manager.query(
        `SELECT count(*)::int AS today FROM email_confirmation_sends WHERE project_id = $1 AND last_sent_at > now() - interval '1 day'`,
        [projectId],
      );
      if (today >= CONFIRMATIONS_PER_PROJECT_PER_DAY) return null;
      const hash = createHmac('sha256', this.sendsKey).update(`${projectId}\n${mailboxOf(address)}`).digest('hex');
      const claimed: Array<{ last_sent_at: Date }> = await manager.query(
        `INSERT INTO email_confirmation_sends (project_id, address_hash, last_sent_at)
         VALUES ($1, $2, date_trunc('milliseconds', now()))
         ON CONFLICT (project_id, address_hash) DO UPDATE SET last_sent_at = date_trunc('milliseconds', now())
           WHERE email_confirmation_sends.last_sent_at < now() - interval '${RESEND_AFTER}'
         RETURNING last_sent_at`,
        [projectId, hash],
      );
      if (claimed.length === 0) {
        // Mailed recently (this spelling or another of the same inbox): take these rows
        // out of the due set until then, so they do not fill every tick's batch.
        await manager.query(
          `UPDATE device_identities d SET email_confirm_sent_at = c.last_sent_at
             FROM email_confirmation_sends c
            WHERE c.project_id = $1 AND c.address_hash = $3
              AND d.project_id = $1 AND d.email = $2 AND d.email_confirmed_at IS NULL`,
          [projectId, address, hash],
        );
        return null;
      }
      const sentAt = new Date(claimed[0].last_sent_at);
      await manager.query(
        `UPDATE device_identities SET email_confirm_sent_at = $3
          WHERE project_id = $1 AND email = $2 AND email_confirmed_at IS NULL`,
        [projectId, address, sentAt],
      );
      return sentAt;
    });
  }

  private async mail(projectId: string, address: string, sentAt: Date): Promise<boolean> {
    const { settings, credentials } = await this.settings.requireSendable(projectId);
    const link = this.url(projectId, address, sentAt);
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
