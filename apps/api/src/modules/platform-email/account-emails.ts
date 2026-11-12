import type { PlatformEmail } from './platform-email.service';

/** Every value placed in an HTML part goes through this. A name is whatever was typed. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * From `app.appUrl` only. A link built from a request's Host could be aimed anywhere.
 * The token goes in the fragment because browsers never send one: in a query string it
 * would land in every access log in front of the dashboard, and in the Referer of the
 * page's own asset requests.
 */
export function accountLink(appUrl: string, path: string, token?: string): string {
  const url = `${appUrl.replace(/\/+$/, '')}${path}`;
  return token ? `${url}#token=${encodeURIComponent(token)}` : url;
}

function compose(
  to: string,
  subject: string,
  name: string | null,
  paragraphs: string[],
  action?: { label: string; url: string },
): PlatformEmail {
  const greeting = name === null ? 'Hi,' : `Hi ${name},`;
  const html = [
    `<p>${escapeHtml(greeting)}</p>`,
    ...paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`),
    ...(action
      ? [`<p><a href="${escapeHtml(action.url)}">${escapeHtml(action.label)}</a></p>`]
      : []),
  ].join('\n');
  const text = [greeting, ...paragraphs, ...(action ? [`${action.label}: ${action.url}`] : [])].join(
    '\n\n',
  );
  return { to, subject, html, text };
}

interface Recipient {
  email: string;
  name: string;
}

export function verificationEmail(user: Recipient, link: string): PlatformEmail {
  return compose(
    user.email,
    'Confirm your email address',
    user.name,
    [
      'Please confirm this is your email address for your Chumbaq account. The link works once and lasts 24 hours.',
      'If you did not create this account, you can ignore this email.',
    ],
    { label: 'Confirm email address', url: link },
  );
}

export function passwordResetEmail(user: Recipient, link: string): PlatformEmail {
  return compose(
    user.email,
    'Reset your Chumbaq password',
    user.name,
    [
      'Someone asked to reset the password for your Chumbaq account. The link works once and lasts 30 minutes.',
      'If this was not you, you can ignore this email and your password stays as it is.',
    ],
    { label: 'Reset password', url: link },
  );
}

/** A factor is a way into the account, so its owner hears of every change at once. */
export function passkeyChangedEmail(
  user: Recipient,
  change: 'added' | 'removed',
  name: string,
  settingsLink: string,
): PlatformEmail {
  return compose(
    user.email,
    `A passkey was ${change} on your Chumbaq account`,
    user.name,
    [
      `The passkey "${name}" was just ${change}, and your other devices were signed out.`,
      'If this was not you, contact support straight away: your account may be compromised.',
    ],
    { label: 'Review your passkeys', url: settingsLink },
  );
}

export function privacyKeyCreatedEmail(
  user: Recipient,
  keyName: string,
  projectName: string,
  keysLink: string,
): PlatformEmail {
  return compose(
    user.email,
    'A privacy API key was created on your Chumbaq account',
    user.name,
    [
      `A server-only privacy key named "${keyName}" was just created in the project "${projectName}".`,
      'It can erase or export any person in that project. Keep it on your servers only.',
      'If this was not you, revoke the key now and contact support: your account may be compromised.',
    ],
    { label: 'Review API keys', url: keysLink },
  );
}

export function totpChangedEmail(
  user: Recipient,
  change: 'added' | 'removed',
  settingsLink: string,
): PlatformEmail {
  return compose(
    user.email,
    `An authenticator app was ${change} on your Chumbaq account`,
    user.name,
    [
      `An authenticator app was just ${change}, and your other devices were signed out.`,
      'If this was not you, contact support straight away: your account may be compromised.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}

/**
 * A password alone opened a session that can add a staff sign-in method. No link: the
 * admin app is staff-only, and the advice is to tell the other operators, not to click.
 */
export function staffEnrolmentStartedEmail(
  user: Recipient,
  ipAddress: string | null,
): PlatformEmail {
  return compose(
    user.email,
    'Staff sign-in setup started on your Chumbaq account',
    user.name,
    [
      `Someone signed in to the Chumbaq admin app with your password${ipAddress ? ` (IP address ${ipAddress})` : ''} to set up a staff sign-in method.`,
      'If this was you, there is nothing to do. If not, tell the other operators straight away and change your password.',
    ],
  );
}

export function recoveryCodeUsedEmail(
  user: Recipient,
  remaining: number,
  settingsLink: string,
): PlatformEmail {
  return compose(
    user.email,
    'A recovery code was used on your Chumbaq account',
    user.name,
    [
      `A recovery code was just used to confirm it was you. You have ${remaining} left.`,
      'If you have lost your authenticator app, remove it and set it up again.',
      'If this was not you, someone has your password and a recovery code. Contact support straight away.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}

export function recoveryCodesReplacedEmail(user: Recipient, settingsLink: string): PlatformEmail {
  return compose(
    user.email,
    'Your Chumbaq recovery codes were replaced',
    user.name,
    [
      'New recovery codes were just made. The old ones no longer work, and your other devices were signed out.',
      'If this was not you, contact support straight away: your account may be compromised.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}

export function newDeviceEmail(
  user: Recipient,
  device: string,
  ipAddress: string | null,
  forgotPasswordLink: string,
): PlatformEmail {
  return compose(
    user.email,
    'New sign-in to your Chumbaq account',
    user.name,
    [
      `Your account was just signed in to from ${device}${ipAddress ? ` (IP address ${ipAddress})` : ''}, which we have not seen on it before.`,
      'If this was you, there is nothing to do. If not, reset your password now.',
    ],
    { label: 'Reset password', url: forgotPasswordLink },
  );
}

export function sessionReplayedEmail(user: Recipient, forgotPasswordLink: string): PlatformEmail {
  return compose(
    user.email,
    'We ended a Chumbaq session on your account',
    user.name,
    [
      'A saved sign-in on your account was used after it had already been replaced, which can mean someone else has a copy of it, so we ended that session.',
      'A poor connection can occasionally cause this too, so you may just need to sign in again. If it keeps happening, or you do not recognise it, reset your password.',
    ],
    { label: 'Reset password', url: forgotPasswordLink },
  );
}

export function passwordChangedByOwnerEmail(
  user: Recipient,
  forgotPasswordLink: string,
): PlatformEmail {
  return compose(
    user.email,
    'Your Chumbaq password was changed',
    user.name,
    [
      'The password for your Chumbaq account was just changed from your account settings, and every device was signed out.',
      'If this was not you, reset your password now and contact support.',
    ],
    { label: 'Reset password', url: forgotPasswordLink },
  );
}

export function passwordChangedEmail(user: Recipient, forgotPasswordLink: string): PlatformEmail {
  return compose(
    user.email,
    'Your Chumbaq password was changed',
    user.name,
    [
      'The password for your Chumbaq account was just reset, and every device was signed out.',
      'If this was not you, reset your password now and contact support.',
    ],
    { label: 'Reset password', url: forgotPasswordLink },
  );
}

/** UTC and spelled out, because the reader's timezone is unknown and the hour matters. */
function formatInstant(when: Date): string {
  return when.toUTCString().replace('GMT', 'UTC');
}

/** The longest a tenant-typed name may run in an email. */
export const DISPLAY_NAME_MAX = 60;

/** Look-alike full stops: ideographic, fullwidth, halfwidth ideographic, one-dot leader. */
const LOOKALIKE_DOTS = /[\u3002\uFF0E\uFF61\u2024]/g;

/** A word holding any of these could be, or help build, an address or link. */
const LINK_CHARS = /[.@:/]/;

/**
 * A tenant-typed name (project, inviter) as it may appear in mail from Chumbaq, so
 * nobody can use our sender to deliver a link. Strict by design, no pattern to dodge:
 * NFKC-normalise, turn look-alike dots into `.`, split on whitespace and drop every
 * word containing `.`, `@`, `:` or `/` (so `Acme Inc.` becomes `Acme`), join with single
 * spaces, and cut past 60 code points (never inside a surrogate pair) with "…".
 * For the email only; stored names are untouched. Plain text: the HTML part still escapes it.
 */
export function safeDisplayName(value: string): string {
  const words = value
    .normalize('NFKC')
    .replace(LOOKALIKE_DOTS, '.')
    .split(/\s+/)
    .filter((word) => word !== '' && !LINK_CHARS.test(word));
  const chars = [...words.join(' ')];
  return chars.length <= DISPLAY_NAME_MAX ? chars.join('') : `${chars.slice(0, DISPLAY_NAME_MAX).join('')}…`;
}

const ROLE_PHRASE: Record<'owner' | 'admin' | 'member', string> = {
  owner: 'an owner',
  admin: 'an admin',
  member: 'a member',
};

/**
 * An invitation to a project, to an address that may have no account yet (so no name to
 * greet). The project and inviter names are whatever a tenant typed: passed through
 * `safeDisplayName`, escaped in the HTML like every value, and kept out of the subject,
 * so nobody writes the headline of mail sent from Chumbaq or puts a link in it. `link` is `accountLink(appUrl, '/invite', token)`; never log it.
 */
export function projectInviteEmail(
  to: string,
  details: {
    projectName: string;
    inviterName: string;
    role: 'owner' | 'admin' | 'member';
    link: string;
    expiresAt: Date;
  },
): PlatformEmail {
  const inviter = safeDisplayName(details.inviterName) || 'Someone';
  const projectName = safeDisplayName(details.projectName);
  const project = projectName ? `the project "${projectName}"` : 'a project';
  return compose(
    to,
    'You have been invited to a Chumbaq project',
    null,
    [
      `${inviter} invited you to join ${project} on Chumbaq as ${ROLE_PHRASE[details.role]}.`,
      `Sign in or create an account with this email address to accept. The link works once and lasts until ${formatInstant(details.expiresAt)}.`,
      'If you were not expecting this, you can ignore this email.',
    ],
    { label: 'Accept the invitation', url: details.link },
  );
}

/**
 * The real owner's chance to stop someone who talked staff into this. Says how, both
 * ways: cancelling in settings, or simply signing in with a factor they still have.
 */
export function factorResetRequestedEmail(
  user: Recipient,
  executeAfter: Date,
  settingsLink: string,
): PlatformEmail {
  return compose(
    user.email,
    'Your Chumbaq second factors will be removed',
    user.name,
    [
      'Chumbaq support has been asked to remove the passkeys, authenticator app and recovery codes from your account, because they were reported lost.',
      `This will happen on ${formatInstant(executeAfter)}. After that your password alone will sign in, and every device will be signed out.`,
      'If you still have a passkey or your authenticator app, signing in with it cancels this. You can also cancel it from your account settings.',
      'If you did not ask for this, cancel it now and contact support: someone may be trying to take over your account.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}

export function factorResetCancelledEmail(user: Recipient, settingsLink: string): PlatformEmail {
  return compose(
    user.email,
    'The removal of your Chumbaq second factors was cancelled',
    user.name,
    [
      'The request to remove the second factors from your account has been cancelled. Nothing was removed.',
      'If you still cannot sign in, contact support.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}

export function factorsResetEmail(user: Recipient, settingsLink: string): PlatformEmail {
  return compose(
    user.email,
    'Your Chumbaq second factors were removed',
    user.name,
    [
      'As requested through Chumbaq support, the passkeys, authenticator app and recovery codes on your account have been removed, and every device was signed out.',
      'Sign in with your password, then set up a new second factor straight away.',
      'If you did not ask for this, reset your password now and contact support.',
    ],
    { label: 'Set up a second factor', url: settingsLink },
  );
}

/**
 * The dashboard page that cancels staff links. It works from a session the owner
 * already has, where a sign-in page would just send them on to their projects, and
 * signs them in first when they have none.
 */
export const STAFF_LINK_CANCEL_PATH = '/account/cancel-support-link';

/**
 * The owner's warning that support handed someone a password reset link in their name.
 * Never carries the link, since this mailbox may be what an attacker holds. The button
 * goes to the cancel page (`STAFF_LINK_CANCEL_PATH`).
 */
export function staffResetLinkIssuedEmail(user: Recipient, usableAt: Date, cancelLink: string): PlatformEmail {
  return compose(
    user.email,
    'Support issued a password reset link for your account',
    user.name,
    [
      'Chumbaq support has issued a link to reset the password on your account, for someone who said they had lost access to it.',
      `The link cannot be used before ${formatInstant(usableAt)}.`,
      'If you did not ask for this, cancel the link now. You will be asked to confirm it is you. Then contact support to report it: someone may be trying to take over your account.',
    ],
    { label: 'Cancel the link', url: cancelLink },
  );
}

/** `signed_in`: a complete sign-in voided it. `cancelled`: the owner pressed cancel. */
export type StaffLinkCancelledBy = 'signed_in' | 'cancelled';

export function staffResetLinkCancelledEmail(
  user: Recipient,
  settingsLink: string,
  why: StaffLinkCancelledBy = 'signed_in',
): PlatformEmail {
  return compose(
    user.email,
    'The password reset link support issued was cancelled',
    user.name,
    [
      why === 'cancelled'
        ? 'You cancelled the password reset link Chumbaq support issued for your account. Your password was not changed.'
        : 'You signed in, so the password reset link Chumbaq support issued for your account has been cancelled. Your password was not changed.',
      'If you did not ask support for a link, contact them to report it.',
    ],
    { label: 'Review your security settings', url: settingsLink },
  );
}
