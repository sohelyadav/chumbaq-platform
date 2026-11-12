import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CredentialsCryptoService } from '../../common/credentials-crypto.service';
import { UNSUBSCRIBE_KEY_PURPOSE, UnsubscribeLinks } from './unsubscribe-link';

/** Unsubscribe links for this deployment: its key, its public base URL. */
@Injectable()
export class EmailUnsubscribeService {
  private readonly links: UnsubscribeLinks;

  constructor(crypto: CredentialsCryptoService, config: ConfigService) {
    this.links = new UnsubscribeLinks(
      crypto.deriveKey(UNSUBSCRIBE_KEY_PURPOSE),
      String(config.get('app.baseUrl') ?? ''),
    );
  }

  url(projectId: string, address: string): string {
    return this.links.url(projectId, address);
  }

  verify(projectId: unknown, encodedAddress: unknown, signature: unknown): string | null {
    return this.links.verify(projectId, encodedAddress, signature);
  }
}
