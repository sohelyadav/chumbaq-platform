import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, MoreThan, Repository } from 'typeorm';
import { AuthEventEntity, AuthEventType } from './entities/auth-event.entity';

export interface RequestContext {
  ipAddress?: string | null;
  userAgent?: string | null;
}

export interface AuthEventEntry extends RequestContext {
  type: AuthEventType;
  userId?: string | null;
  email?: string | null;
  reason?: string | null;
  sessionId?: string | null;
}

const USER_AGENT_LIMIT = 512;

/**
 * What a person is shown of their own account's history: sign-ins, failures and changes
 * to how they sign in. Not refreshes or plain sign-outs, which happen all day and would
 * bury the rest, nor `login.limited`, which is kept by address and not by account.
 */
export const ACCOUNT_HISTORY_TYPES: AuthEventType[] = [
  'register.succeeded',
  'login.succeeded',
  'login.failed',
  'passkey.added',
  'passkey.removed',
  'totp.enabled',
  'totp.disabled',
  'recovery_code.used',
  'recovery_codes.regenerated',
  'refresh.reuse_detected',
  'logout.all',
  'session.revoked',
  'sessions.revoked_others',
  'password.changed',
  'password.reset',
  'password.reset_by_team',
  'email.verified',
  'factors_reset.requested',
  'factors_reset.cancelled',
  'factors_reset.completed',
];

export const ACCOUNT_HISTORY_DAYS = 90;
const ACCOUNT_HISTORY_LIMIT = 100;

@Injectable()
export class AuthEventsService {
  private readonly logger = new Logger(AuthEventsService.name);

  constructor(
    @InjectRepository(AuthEventEntity)
    private readonly repository: Repository<AuthEventEntity>,
  ) {}

  /**
   * Never throws. Nobody should be locked out of their account because the
   * record of it could not be written, so a failure here goes to the log.
   */
  async record(entry: AuthEventEntry): Promise<void> {
    try {
      await this.repository.insert({
        type: entry.type,
        userId: entry.userId ?? null,
        email: entry.email?.toLowerCase().slice(0, 255) ?? null,
        reason: entry.reason ?? null,
        sessionId: entry.sessionId ?? null,
        ipAddress: entry.ipAddress ?? null,
        userAgent: entry.userAgent?.slice(0, USER_AGENT_LIMIT) ?? null,
      });
    } catch (error) {
      this.logger.error(`Could not record ${entry.type}: ${(error as Error).message}`);
    }
  }

  /** Newest first. `reason` is left out: it is for staff, never the person signing in. */
  history(userId: string): Promise<Omit<AuthEventEntity, 'reason' | 'user' | 'userId' | 'email'>[]> {
    return this.repository.find({
      select: { id: true, type: true, sessionId: true, ipAddress: true, userAgent: true, createdAt: true },
      where: {
        userId,
        type: In(ACCOUNT_HISTORY_TYPES),
        createdAt: MoreThan(new Date(Date.now() - ACCOUNT_HISTORY_DAYS * 86_400_000)),
      },
      order: { createdAt: 'DESC' },
      take: ACCOUNT_HISTORY_LIMIT,
    });
  }

  /**
   * Failed sign-ins for an address since its last success or password reset, within
   * the window. A reset counts because the failures were against a password that no
   * longer exists, and otherwise a stranger's guesses would lock out the new one.
   * Keyed on the address and not the account, so an unknown address behaves the
   * same as a real one and the limit reveals nothing. Fails open: an outage here
   * must not lock everyone out, and the per-IP throttle still applies.
   */
  async recentLoginFailures(email: string, windowMinutes: number): Promise<number> {
    try {
      const [row] = await this.repository.query(
        `SELECT count(*)::int AS failures
           FROM auth_events e
          WHERE e.email = $1
            AND e.type = 'login.failed'
            AND e.created_at > now() - make_interval(mins => $2)
            AND e.created_at > COALESCE(
                  (SELECT max(s.created_at) FROM auth_events s
                    WHERE s.email = $1 AND s.type IN ('login.succeeded', 'password.reset')),
                  '-infinity')`,
        [email.toLowerCase(), windowMinutes],
      );
      return row.failures;
    } catch (error) {
      this.logger.error(`Could not count login failures: ${(error as Error).message}`);
      return 0;
    }
  }
}
