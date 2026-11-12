import { ForbiddenException, Injectable } from '@nestjs/common';
import { REAUTH_REQUIRED_MESSAGE } from './guards/recent-auth.guard';
import { FACTOR_CHANGE_PROOF, PreAuthService } from './pre-auth.service';
import { SessionsService } from './sessions.service';
import { StaffSessionsService } from './staff-sessions.service';

/** The staff proof, kept apart so neither app's re-authentication can stand in for the other's. */
export const STAFF_FACTOR_CHANGE_PROOF = 'staff-factor-change-proof';

interface Holder {
  userId: string;
  sessionId?: string;
  /** Whose session this is. Absent means the customer app's. */
  audience?: 'customer' | 'staff';
}

/**
 * The single-use proof that adding or removing a factor needs. Its session must still be
 * live: an access token outlasts a revoked session by up to 15 minutes, which is long
 * enough for whoever was just signed out to use a proof left behind.
 *
 * Refused with the message the web client answers with its prompt, then resends.
 */
@Injectable()
export class FactorChangeProofService {
  constructor(
    private readonly preAuth: PreAuthService,
    private readonly sessions: SessionsService,
    private readonly staffSessions: StaffSessionsService,
  ) {}

  private ceremony(holder: Holder): string {
    return holder.audience === 'staff' ? STAFF_FACTOR_CHANGE_PROOF : FACTOR_CHANGE_PROOF;
  }

  private async assertLive({ userId, sessionId, audience }: Holder): Promise<string> {
    const live =
      sessionId &&
      (audience === 'staff'
        ? await this.staffSessions.isUsable(sessionId, userId)
        : await this.sessions.isLive(sessionId, userId));
    if (!live) throw new ForbiddenException(REAUTH_REQUIRED_MESSAGE);
    return sessionId as string;
  }

  /** Left by a real re-authentication of this session. */
  async leave(holder: Required<Pick<Holder, 'sessionId'>> & Holder): Promise<void> {
    await this.preAuth.putChallenge(this.ceremony(holder), holder.sessionId, '1');
  }

  async assertHeld(holder: Holder): Promise<void> {
    const sessionId = await this.assertLive(holder);
    if (!(await this.preAuth.peekChallenge(this.ceremony(holder), sessionId))) {
      throw new ForbiddenException(REAUTH_REQUIRED_MESSAGE);
    }
  }

  async spend(holder: Holder): Promise<void> {
    const sessionId = await this.assertLive(holder);
    if (!(await this.preAuth.takeChallenge(this.ceremony(holder), sessionId))) {
      throw new ForbiddenException(REAUTH_REQUIRED_MESSAGE);
    }
  }
}
