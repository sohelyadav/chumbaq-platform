import { stubCalls, type StubCall } from './provider-stub';

/**
 * Account email as the e2e stack sends it: Chumbaq's own sender (platform email) posts
 * each mail to the provider stub's Brevo (`POST /v3/smtp/email`), which records it. These
 * read the mail back. Addresses compare case-insensitively, as the API stores them
 * lower-cased.
 */

export interface Mail {
  to: string;
  from: string;
  subject: string;
  html: string;
  text: string;
  /** When the stub received it (ISO). */
  at: string;
}

interface BrevoSend {
  sender?: { name?: string; email?: string };
  to?: Array<{ email?: string }>;
  subject?: string;
  htmlContent?: string;
  textContent?: string;
}

export interface MailQuery {
  /** Only mail whose subject contains this. */
  subjectIncludes?: string;
  /** Only mail received at or after this time (default: any). */
  since?: Date;
}

function toMail(call: StubCall): Mail | null {
  if (call.method !== 'POST' || call.path !== '/v3/smtp/email') return null;
  const body = (call.body ?? {}) as BrevoSend;
  const sender = body.sender ?? {};
  return {
    to: body.to?.[0]?.email ?? '',
    from: sender.name ? `${sender.name} <${sender.email}>` : (sender.email ?? ''),
    subject: body.subject ?? '',
    html: body.htmlContent ?? '',
    text: body.textContent ?? '',
    at: call.at,
  };
}

/** Every account mail sent to `to` (matching `query`), oldest first. */
export async function mailsTo(to: string, query: MailQuery = {}): Promise<Mail[]> {
  const address = to.trim().toLowerCase();
  return (await stubCalls('platform-brevo'))
    .map(toMail)
    .filter((mail): mail is Mail => mail !== null)
    .filter((mail) => mail.to.toLowerCase() === address)
    .filter((mail) => query.subjectIncludes === undefined || mail.subject.includes(query.subjectIncludes))
    .filter((mail) => query.since === undefined || new Date(mail.at) >= query.since);
}

/** The newest account mail to `to` matching `query`, or null. */
export async function latestMail(to: string, query: MailQuery = {}): Promise<Mail | null> {
  const mails = await mailsTo(to, query);
  return mails.length ? mails[mails.length - 1] : null;
}

/**
 * Waits for an account mail to `to` matching `query` (several send after responding,
 * so it can arrive after the request that caused it has answered), and returns the
 * newest. Throws after `timeoutMs`, naming the subjects that did arrive.
 */
export async function waitForMail(to: string, query: MailQuery = {}, timeoutMs = 15_000): Promise<Mail> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const mail = await latestMail(to, query);
    if (mail) return mail;
    if (Date.now() > deadline) {
      const arrived = (await mailsTo(to)).map((m) => `"${m.subject}"`);
      throw new Error(
        `No account mail to ${to}${query.subjectIncludes ? ` with "${query.subjectIncludes}" in its subject` : ''} within ${timeoutMs} ms` +
          ` (arrived: ${arrived.length ? arrived.join(', ') : 'none'})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * The first link in `mail` whose path is `pathname` (e.g. `/complete-signup`), whole:
 * account links carry their token in the fragment (`#token=...`). Read from the text
 * part, then the HTML part's hrefs. Throws when there is none.
 */
export function extractLink(mail: Mail, pathname: string): string {
  const candidates = [
    ...(mail.text.match(/https?:\/\/[^\s<>"']+/g) ?? []),
    ...Array.from(mail.html.matchAll(/href="([^"]+)"/g), (match) => match[1].replace(/&amp;/g, '&')),
  ];
  for (const candidate of candidates) {
    try {
      if (new URL(candidate).pathname === pathname) return candidate;
    } catch {
      // Not a URL; keep looking.
    }
  }
  throw new Error(`The mail "${mail.subject}" to ${mail.to} has no link to ${pathname}`);
}

/** The `token` in a link's fragment (`#token=...`). */
export function tokenFromLink(link: string): string {
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get('token');
  if (!token) throw new Error(`The link to ${new URL(link).pathname} carries no #token=`);
  return token;
}
