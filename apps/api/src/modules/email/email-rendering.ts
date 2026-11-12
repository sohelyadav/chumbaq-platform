import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  renderTemplate,
  tidyRendered,
} from '../push-notifications/push-personalisation';
import { EmailContent } from '../push-notifications/message-channel';

/** What an email provider is handed for one recipient. */
export interface EmailMessage {
  /** RFC 5322 `From`, already formatted: `"Name" <address>`. */
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  /** Extra headers, chiefly the RFC 8058 unsubscribe pair. */
  headers: Record<string, string>;
  /**
   * Returned on the provider's delivery events, which is how a bounce or a
   * click finds its way back to a campaign and a person.
   */
  tags: Record<string, string>;
}

/** Tag names carried on every send and read back from webhooks. */
export const CAMPAIGN_TAG = 'chumbaq_campaign_id';
export const IDENTITY_TAG = 'chumbaq_identity_id';

export interface Sender {
  fromEmail: string;
  fromName: string | null;
  replyTo: string | null;
  postalAddress: string;
}

const UNSUBSCRIBE_TOKEN = /\{\{\s*unsubscribe_url\s*\}\}/g;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Removes anything that could end a header line.
 *
 * The subject is personalised from traits, which are user-supplied, and a
 * CR/LF in a header value is header injection — a `Bcc:` smuggled in through
 * someone's first name.
 */
export function headerSafe(value: string): string {
  return value.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, ' ').trim();
}

export function formatFrom(sender: Pick<Sender, 'fromEmail' | 'fromName'>): string {
  const name = sender.fromName ? headerSafe(sender.fromName) : '';
  if (!name) return sender.fromEmail;
  return `"${name.replace(/["\\]/g, '\\$&')}" <${sender.fromEmail}>`;
}

/**
 * A plain-text rendering of HTML, for the text part when none was written.
 *
 * Not a full converter: it only has to be readable, because the text part is
 * what spam filters weigh and what a text-only client shows. Links keep their
 * destination, since "click here" with no URL is useless as text.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<(head|style|script|title)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, label) => {
      const text = label.replace(/<[^>]+>/g, '').trim();
      return text && text !== href ? `${text} (${href})` : href;
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|h[1-6]|li|tr|table|blockquote)>/gi, '\n\n')
    .replace(/<li[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Puts `fragment` just inside `<body>`, or at the start when there is none. */
function afterBodyOpen(html: string, fragment: string): string {
  const match = /<body[^>]*>/i.exec(html);
  if (!match) return fragment + html;
  const at = match.index + match[0].length;
  return html.slice(0, at) + fragment + html.slice(at);
}

/** Puts `fragment` just before `</body>`, or at the end when there is none. */
function beforeBodyClose(html: string, fragment: string): string {
  const at = html.search(/<\/body>/i);
  if (at === -1) return html + fragment;
  return html.slice(0, at) + fragment + html.slice(at);
}

/**
 * Renders one recipient's email from the campaign's content.
 *
 * Every marketing email leaves here with a way out and a postal address. The
 * unsubscribe link goes where the author put `{{unsubscribe_url}}`, and in the
 * footer when they put it nowhere — an email without one is a CAN-SPAM
 * violation, and since February 2024 Gmail and Yahoo reject bulk mail that
 * lacks one-click unsubscribe headers.
 */
export function renderEmail(input: {
  content: EmailContent;
  identity: Partial<DeviceIdentityEntity> | null;
  sender: Sender;
  unsubscribeUrl: string;
  tags: Record<string, string>;
}): EmailMessage {
  const { content, identity, sender, unsubscribeUrl } = input;

  const subject = headerSafe(
    tidyRendered(renderTemplate(content.subject, identity)),
  );

  const authorPlacedLink = UNSUBSCRIBE_TOKEN.test(content.html);
  UNSUBSCRIBE_TOKEN.lastIndex = 0;

  let html = renderTemplate(
    content.html.replace(UNSUBSCRIBE_TOKEN, escapeHtml(unsubscribeUrl)),
    identity,
    escapeHtml,
  );

  if (content.preheader) {
    const preheader = escapeHtml(
      tidyRendered(renderTemplate(content.preheader, identity)),
    );
    // Hidden in the body but read by inbox previews. The padding after it
    // stops clients filling the preview with the start of the visible copy.
    html = afterBodyOpen(
      html,
      `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all">${preheader}${'&#847;&zwnj;&nbsp;'.repeat(30)}</div>`,
    );
  }

  const footerLink = authorPlacedLink
    ? ''
    : `<a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b7280">Unsubscribe</a><br>`;
  html = beforeBodyClose(
    html,
    `<div style="margin-top:32px;font-size:12px;line-height:1.5;color:#6b7280;text-align:center">${footerLink}${escapeHtml(sender.postalAddress).replace(/\n/g, '<br>')}</div>`,
  );

  const authoredText = content.text
    ? renderTemplate(content.text.replace(UNSUBSCRIBE_TOKEN, unsubscribeUrl), identity)
    : htmlToText(
        renderTemplate(
          content.html.replace(UNSUBSCRIBE_TOKEN, unsubscribeUrl),
          identity,
        ),
      );
  const text = `${authoredText}\n\n--\nUnsubscribe: ${unsubscribeUrl}\n${sender.postalAddress}`;

  return {
    from: formatFrom(sender),
    replyTo: sender.replyTo ?? undefined,
    subject,
    html,
    text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
    tags: input.tags,
  };
}
