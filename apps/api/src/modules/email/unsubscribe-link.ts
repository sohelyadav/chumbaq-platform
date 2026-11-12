import { createHmac, timingSafeEqual } from 'crypto';

/** HKDF purpose for the unsubscribe signing key. Changing it voids every link. */
export const UNSUBSCRIBE_KEY_PURPOSE = 'chumbaq/email-unsubscribe/v1';

/**
 * Signs and checks unsubscribe links.
 *
 * The link carries the project and the address in the clear and an HMAC over
 * both. Nothing is stored per email sent, so a link keeps working for as long
 * as the key does — an unsubscribe from a two-year-old email is still an
 * unsubscribe — and a link cannot be edited to unsubscribe somebody else.
 */
export class UnsubscribeLinks {
  constructor(
    private readonly key: Buffer,
    private readonly apiBaseUrl: string,
  ) {}

  url(projectId: string, address: string): string {
    const params = new URLSearchParams({
      p: projectId,
      e: Buffer.from(address, 'utf8').toString('base64url'),
      s: this.sign(projectId, address),
    });
    return `${this.apiBaseUrl.replace(/\/+$/, '')}/api/email/unsubscribe?${params}`;
  }

  /** The address a link was signed for, or null when it was not signed by us. */
  verify(projectId: unknown, encodedAddress: unknown, signature: unknown): string | null {
    if (
      typeof projectId !== 'string' ||
      typeof encodedAddress !== 'string' ||
      typeof signature !== 'string'
    ) {
      return null;
    }

    const address = Buffer.from(encodedAddress, 'base64url').toString('utf8');
    const expected = Buffer.from(this.sign(projectId, address), 'utf8');
    const given = Buffer.from(signature, 'utf8');

    if (expected.length !== given.length) return null;
    return timingSafeEqual(expected, given) ? address : null;
  }

  private sign(projectId: string, address: string): string {
    // A separator that cannot occur in a uuid, so (project, address) pairs
    // cannot be shifted into one another.
    return createHmac('sha256', this.key)
      .update(`${projectId}\n${address}`)
      .digest('base64url');
  }
}
