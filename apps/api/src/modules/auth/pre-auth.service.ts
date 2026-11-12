import { createHash, randomBytes } from 'crypto';
import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

export const PRE_AUTH_TTL_SECONDS = 5 * 60;

/**
 * Left by a real re-authentication and spent by the factor change it permits. Having
 * signed in recently is not enough for that: a stolen token has that too, and a passkey
 * planted with one would outlast a password reset.
 */
export const FACTOR_CHANGE_PROOF = 'factor-change-proof';

/** What a correct password has established, and nothing more. */
export interface PreAuthState {
  userId: string;
  /** `users.session_version` then, so a reset or logout-all in between kills the handle. */
  sessionVersion: number;
  amr: string[];
  /**
   * Which sign-in this handle belongs to. Absent means the customer app's. Each side
   * reads only its own, so a password accepted on one app cannot finish on the other.
   */
  audience?: PreAuthAudience;
}

export type PreAuthAudience = 'customer' | 'staff';

const belongsTo = (state: PreAuthState | null, audience: PreAuthAudience): PreAuthState | null =>
  state && (state.audience ?? 'customer') === audience ? state : null;

const keyFor = (handle: string) =>
  `chumbaq:preauth:${createHash('sha256').update(handle).digest('hex')}`;

const challengeKey = (ceremony: string, id: string) =>
  `chumbaq:webauthn:${ceremony}:${createHash('sha256').update(id).digest('hex')}`;

/**
 * The state between a correct password and a second factor. A handle is opaque and
 * not a JWT, so no bug in `JwtStrategy` can ever accept one as a session. Only its
 * hash is a Redis key, so reading Redis yields nothing that can be presented.
 */
@Injectable()
export class PreAuthService implements OnModuleDestroy {
  private readonly logger = new Logger(PreAuthService.name);
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis({
      host: config.getOrThrow<string>('redis.host'),
      port: config.getOrThrow<number>('redis.port'),
      password: config.get<string>('redis.password'),
      db: config.get<number>('redis.db'),
      lazyConnect: true,
      // Signing in should fail rather than hang while Redis is away.
      maxRetriesPerRequest: 1,
    });
    this.redis.on('error', (error: Error) =>
      this.logger.error(`Redis unavailable for sign-in: ${error.message}`),
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.redis.disconnect();
  }

  async create(state: PreAuthState): Promise<string> {
    const handle = randomBytes(32).toString('base64url');
    await this.redis.set(keyFor(handle), JSON.stringify(state), 'EX', PRE_AUTH_TTL_SECONDS);
    return handle;
  }

  /** Reads without spending, so a wrong second factor can be tried again. */
  async peek(handle: string): Promise<PreAuthState | null> {
    const stored = await this.redis.get(keyFor(handle));
    return stored ? (JSON.parse(stored) as PreAuthState) : null;
  }

  /** `peek`, for one audience only: another's handle reads as no handle at all. */
  async peekFor(handle: string, audience: PreAuthAudience): Promise<PreAuthState | null> {
    return belongsTo(await this.peek(handle), audience);
  }

  /**
   * `consume`, for one audience only. Checked after the GETDEL, so another audience's
   * handle is spent rather than left for its own side: it was presented at the wrong app.
   */
  async consumeFor(handle: string, audience: PreAuthAudience): Promise<PreAuthState | null> {
    return belongsTo(await this.consume(handle), audience);
  }

  /** Replaces any earlier challenge for this ceremony, so only the latest can answer. */
  async putChallenge(ceremony: string, id: string, challenge: string): Promise<void> {
    await this.redis.set(challengeKey(ceremony, id), challenge, 'EX', PRE_AUTH_TTL_SECONDS);
  }

  peekChallenge(ceremony: string, id: string): Promise<string | null> {
    return this.redis.get(challengeKey(ceremony, id));
  }

  /** Works once, so a captured response cannot be played back against it. */
  takeChallenge(ceremony: string, id: string): Promise<string | null> {
    return this.redis.getdel(challengeKey(ceremony, id));
  }

  /** GETDEL is one command, so of two simultaneous uses exactly one gets the state. */
  async consume(handle: string): Promise<PreAuthState | null> {
    const stored = await this.redis.getdel(keyFor(handle));
    return stored ? (JSON.parse(stored) as PreAuthState) : null;
  }
}
