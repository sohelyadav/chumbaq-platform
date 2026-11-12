import { createHash, createSign, generateKeyPairSync, KeyObject, randomBytes } from 'crypto';
import { isoCBOR } from '@simplewebauthn/server/helpers';

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;
const BS = 0x10;
const AT = 0x40;

const b64 = (data: Buffer | Uint8Array) => Buffer.from(data).toString('base64url');
const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest();

export interface FakeAuthenticatorOptions {
  rpId: string;
  origin: string;
  /** A synced passkey, like iCloud Keychain or Google Password Manager. */
  synced?: boolean;
  /** Whether it verifies the user, by PIN or biometric. */
  verifiesUser?: boolean;
  /** Synced passkeys stay at 0; hardware keys count up. */
  counting?: boolean;
}

/**
 * A software authenticator producing real signatures over real WebAuthn structures, so
 * the tests exercise the library's verification rather than a stub of it.
 */
export class FakeAuthenticator {
  readonly credentialId = b64(randomBytes(32));
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  counter = 0;
  userHandle = '';

  constructor(private readonly options: FakeAuthenticatorOptions) {
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey;
  }

  private flags(attesting: boolean): number {
    const { synced, verifiesUser = true } = this.options;
    return (
      UP |
      (verifiesUser ? UV : 0) |
      (synced ? BE | BS : 0) |
      (attesting ? AT : 0)
    );
  }

  private clientData(type: string, challenge: string, origin = this.options.origin): string {
    return JSON.stringify({ type, challenge, origin, crossOrigin: false });
  }

  private counterBytes(): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(this.counter);
    return bytes;
  }

  register(challenge: string, userHandle: string, origin?: string) {
    this.userHandle = userHandle;
    const jwk = this.publicKey.export({ format: 'jwk' });
    const cose = isoCBOR.encode(
      new Map<number, number | Uint8Array>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x as string, 'base64url')],
        [-3, Buffer.from(jwk.y as string, 'base64url')],
      ]),
    );
    const id = Buffer.from(this.credentialId, 'base64url');
    const idLength = Buffer.alloc(2);
    idLength.writeUInt16BE(id.length);
    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags(true)]),
      this.counterBytes(),
      Buffer.alloc(16),
      idLength,
      id,
      Buffer.from(cose),
    ]);
    const attestationObject = isoCBOR.encode(
      new Map<string, unknown>([
        ['fmt', 'none'],
        ['attStmt', new Map()],
        ['authData', authData],
      ]) as never,
    );
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(Buffer.from(this.clientData('webauthn.create', challenge, origin))),
        attestationObject: b64(attestationObject),
        transports: ['usb' as const],
      },
    };
  }

  assert(challenge: string, origin?: string) {
    if (this.options.counting) this.counter += 1;
    const authData = Buffer.concat([
      sha256(this.options.rpId),
      Buffer.from([this.flags(false)]),
      this.counterBytes(),
    ]);
    const clientData = Buffer.from(this.clientData('webauthn.get', challenge, origin));
    const signature = createSign('SHA256')
      .update(Buffer.concat([authData, sha256(clientData)]))
      .sign(this.privateKey);
    return {
      id: this.credentialId,
      rawId: this.credentialId,
      type: 'public-key' as const,
      clientExtensionResults: {},
      response: {
        clientDataJSON: b64(clientData),
        authenticatorData: b64(authData),
        signature: b64(signature),
        userHandle: this.userHandle,
      },
    };
  }
}
