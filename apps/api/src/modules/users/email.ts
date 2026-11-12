import { Transform } from 'class-transformer';

/**
 * The one form an address is stored and looked up in. Mailboxes are case-insensitive in
 * practice, so `Ana@x.com` and `ana@x.com` must be one account, not two.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** For a DTO's address field: runs before validation, so a stray space is not refused. */
export const NormaliseEmail = () =>
  Transform(({ value }) => (typeof value === 'string' ? normaliseEmail(value) : value));
