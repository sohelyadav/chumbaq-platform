import { EmailProviderName } from '../../push-notifications/message-channel';
import {
  PROVIDER_REQUEST_TIMEOUT_MS,
  PerRecipientProvider,
  ProviderAccountError,
} from '../../push-notifications/services/per-recipient-provider';
import { DeliveryProvider } from '../../push-notifications/services/channel-provider';
import { EmailMessage } from '../email-rendering';

export type EmailProvider = DeliveryProvider<EmailMessage, EmailProviderName>;

export type { AttemptResult } from '../../push-notifications/services/per-recipient-provider';
export { readJson } from '../../push-notifications/services/per-recipient-provider';

/**
 * Longest one request to an email provider may take. The same limit as every
 * per-recipient provider's; kept under this name for the email code and docs.
 */
export const EMAIL_PROVIDER_TIMEOUT_MS = PROVIDER_REQUEST_TIMEOUT_MS;

/** An account-level failure at an email provider. See `ProviderAccountError`. */
export class EmailAccountError extends ProviderAccountError {}

/** SES, Resend and Brevo: one request per recipient. */
export abstract class BaseEmailProvider
  extends PerRecipientProvider<EmailMessage, EmailProviderName>
  implements EmailProvider
{}
