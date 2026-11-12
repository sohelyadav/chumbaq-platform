import { Injectable } from '@nestjs/common';
import { createHmac } from 'crypto';
import type { PrivacySubjectType } from '@chumbaq/shared';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import type { MessageChannel } from '../push-notifications/message-channel';

/** HKDF purposes. Changing either orphans every hash already stored. */
export const ERASED_SUPPRESSION_KEY_PURPOSE = 'erased-suppression-v1';
export const PRIVACY_SUBJECT_KEY_PURPOSE = 'privacy-subject-v1';

/**
 * Keyed hashes for what privacy requests leave behind.
 *
 * Keyed (HMAC with a key derived from `CREDENTIALS_ENCRYPTION_KEY`, as
 * unsubscribe links are) rather than a plain SHA-256, because email addresses,
 * phone numbers and user ids are guessable: anyone holding a dump of the table
 * could otherwise hash candidates until one matched. The project is part of
 * every input, so no two projects' hashes can be compared.
 */
@Injectable()
export class PrivacyHashService {
  private readonly suppressionKey: Buffer;
  private readonly subjectKey: Buffer;

  constructor(crypto: CredentialsCryptoService) {
    this.suppressionKey = crypto.deriveKey(ERASED_SUPPRESSION_KEY_PURPOSE);
    this.subjectKey = crypto.deriveKey(PRIVACY_SUBJECT_KEY_PURPOSE);
  }

  /** For `erased_suppressions.address_hash`. `address` must already be normalised. */
  suppressionHash(projectId: string, channel: MessageChannel, address: string): string {
    return hmac(this.suppressionKey, [projectId, channel, address]);
  }

  /** For `privacy_request_logs.identifier_hashes`. */
  subjectHash(projectId: string, type: PrivacySubjectType, value: string): string {
    return hmac(this.subjectKey, [projectId, type, value]);
  }
}

/** Newline-joined. Only the last part is free text (the others are a UUID and a fixed word), so no two inputs join to the same string. */
function hmac(key: Buffer, parts: string[]): string {
  return createHmac('sha256', key).update(parts.join('\n')).digest('hex');
}
