import { createHash, randomBytes } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { AdminImpersonationSession, ImpersonationHandoff } from '@chumbaq/shared';
import { AdminAuditService } from '../admin/admin-audit.service';
import { AdminAuditLogEntity } from '../admin/entities/admin-audit-log.entity';
import { ProjectActivityService } from '../project-activity/project-activity.service';
import { StaffSessionsService } from '../auth/staff-sessions.service';
import { STAFF_SESSION_ENDED_MESSAGE } from '../staff-auth/staff-messages';
import type { JwtPayload } from '../auth/strategies/jwt.strategy';
import { UserEntity } from '../users/entities/user.entity';
import { ImpersonationHandoffEntity } from './entities/impersonation-handoff.entity';
import { IMPERSONATION_LINK_INVALID_MESSAGE } from './impersonation-messages';

/** Long enough to open a tab, too short to be worth stealing from a screen or a log. */
export const HANDOFF_TTL_SECONDS = 60;
const IMPERSONATION_TTL = '30m';

const hashCode = (code: string) => createHash('sha256').update(code).digest('hex');

export interface HandoffActor {
  userId: string;
  email: string;
  sessionId: string;
}

/**
 * View-as across two origins. The admin API makes a one-time code bound to the staff
 * member, their staff session and the tenant; the admin app opens the customer app with
 * it in the URL fragment (never sent to a server, so in no access log or Referer); the
 * customer app posts it to the customer API, which spends it and only then issues the
 * read-only 30-minute token. So the impersonation token is only ever made by, and only
 * ever lives in, the customer side.
 *
 * Neither the code nor its hash is ever logged.
 */
@Injectable()
export class ImpersonationHandoffsService {
  constructor(
    @InjectRepository(ImpersonationHandoffEntity)
    private readonly handoffs: Repository<ImpersonationHandoffEntity>,
    @InjectRepository(UserEntity)
    private readonly users: Repository<UserEntity>,
    private readonly staffSessions: StaffSessionsService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AdminAuditService,
    private readonly activity: ProjectActivityService,
  ) {}

  /** Admin API. The same target rules and messages as view-as always had. */
  async create(input: {
    actor: HandoffActor;
    targetId: string;
    reason: string;
    ipAddress: string;
  }): Promise<ImpersonationHandoff> {
    const { actor, targetId, reason, ipAddress } = input;
    const target = await this.users.findOne({ where: { id: targetId } });
    if (!target) throw new NotFoundException('Tenant not found');
    if (target.id === actor.userId) throw new ConflictException('You cannot impersonate yourself');
    if (target.isSuperAdmin) throw new ConflictException('Super admins cannot be impersonated');
    if (target.suspendedAt) throw new ConflictException('Suspended tenants cannot be impersonated');

    const actorRow = await this.users.findOne({ where: { id: actor.userId } });
    if (!actorRow) throw new NotFoundException('Tenant not found');

    const code = randomBytes(32).toString('base64url');
    const expiresAt = await this.handoffs.manager.transaction(async (manager) => {
      // The guard saw a live session, but a sign-out can commit between it and here, and
      // its sweep of unused codes would then run before this one existed. Under this lock
      // the revoke either has committed (and we refuse) or waits for us (and sweeps it).
      if (!(await this.staffSessions.lockUsable(manager, actor.sessionId, actor.userId))) {
        throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
      }
      const [row] = (await manager.query(
        `INSERT INTO impersonation_handoffs
           (code_hash, actor_id, actor_session_version, staff_session_id, target_id, reason, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, now() + make_interval(secs => $7))
         RETURNING id, expires_at`,
        [hashCode(code), actor.userId, actorRow.sessionVersion, actor.sessionId, target.id, reason, HANDOFF_TTL_SECONDS],
      )) as { id: string; expires_at: Date }[];
      const expiresAt = new Date(row.expires_at).toISOString();
      // In the same transaction: a view-as that could not be recorded must not exist.
      await new AdminAuditService(manager.getRepository(AdminAuditLogEntity)).record(
        {
          actorId: actor.userId,
          actorEmail: actor.email,
          action: 'tenant.impersonated',
          targetType: 'tenant',
          targetId: target.id,
          targetLabel: target.email,
          reason,
          metadata: { handoffId: row.id, codeExpiresAt: expiresAt },
          ipAddress,
        },
        manager,
      );
      return expiresAt;
    });

    const url = `${new URL('/impersonate', this.config.getOrThrow<string>('app.appUrl')).toString()}#code=${code}`;
    return { url, expiresAt, tenant: { id: target.id, email: target.email, name: target.name } };
  }

  /**
   * Customer API. Spent by one conditional UPDATE, so of two simultaneous exchanges
   * exactly one gets the row; everything the code stood for is then checked again, since
   * any of it can change in its 60 seconds. Every failure is the same 400, after the
   * code is spent.
   */
  async exchange(code: string, ctx: { ipAddress: string }): Promise<AdminImpersonationSession> {
    const invalid = () => new BadRequestException(IMPERSONATION_LINK_INVALID_MESSAGE);
    type Spent = {
      id: string;
      actor_id: string;
      actor_session_version: number;
      staff_session_id: string;
      target_id: string;
    };
    // TypeORM answers an UPDATE's raw query with [rows, rowCount].
    const [rows] = (await this.handoffs.query(
      `UPDATE impersonation_handoffs SET used_at = now(), used_ip = $2
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING id, actor_id, actor_session_version, staff_session_id, target_id`,
      [hashCode(code), ctx.ipAddress],
    )) as [Spent[], number];
    const handoff = rows?.[0];
    if (!handoff) throw invalid();

    const [actor, target] = await Promise.all([
      this.users.findOne({ where: { id: handoff.actor_id } }),
      this.users.findOne({ where: { id: handoff.target_id } }),
    ]);
    const refusal = await this.recheck(handoff, actor, target);
    // `!actor || !target` only narrows the types: `recheck` already named those cases.
    if (refusal || !actor || !target) {
      // A real code, made by staff, that was spent and then turned down: the staff log
      // must show it, since `used_ip` alone lives on a row the retention job deletes.
      // Awaited before the answer, which stays the same 400 as for any other failure.
      await this.audit.record({
        // A foreign key: an actor deleted in between is named by nobody.
        actorId: actor?.id ?? null,
        actorEmail: actor?.email ?? 'unknown',
        action: 'tenant.impersonation_refused',
        targetType: 'tenant',
        targetId: handoff.target_id,
        targetLabel: target?.email ?? null,
        metadata: { handoffId: handoff.id, reason: refusal ?? 'missing' },
        ipAddress: ctx.ipAddress,
      });
      throw invalid();
    }

    const payload: JwtPayload = {
      sub: target.id,
      email: target.email,
      type: 'access',
      imp: actor.id,
      sv: target.sessionVersion,
      impSv: actor.sessionVersion,
      impSid: handoff.staff_session_id,
    };
    const accessToken = await this.jwt.signAsync(payload, { expiresIn: IMPERSONATION_TTL });
    const { exp } = this.jwt.decode<{ exp: number }>(accessToken);
    const expiresAt = new Date(exp * 1000).toISOString();

    // Awaited before the token leaves: a session that could not be recorded must not exist.
    await this.audit.record({
      actorId: actor.id,
      actorEmail: actor.email,
      action: 'tenant.impersonation_exchanged',
      targetType: 'tenant',
      targetId: target.id,
      targetLabel: target.email,
      metadata: { handoffId: handoff.id, expiresAt },
      ipAddress: ctx.ipAddress,
    });

    // The customer sees that support looked, in every project view-as can show (those
    // billed to the tenant), and when; never who, why or from where. One INSERT for all.
    const billed = (await this.handoffs.query(`SELECT id FROM projects WHERE owner_id = $1`, [target.id])) as {
      id: string;
    }[];
    await this.activity.recordMany(
      billed.map((project) => ({ projectId: project.id, actor: { kind: 'staff' }, action: 'staff.viewed_as' })),
      { ipAddress: null, userAgent: null },
    );

    return { accessToken, expiresAt, tenant: { id: target.id, email: target.email, name: target.name } };
  }

  /**
   * Why a spent code may not become a session, as a class for the audit entry (never
   * shown to the caller), or null when everything it stood for still holds.
   */
  private async recheck(
    handoff: { actor_session_version: number; staff_session_id: string },
    actor: UserEntity | null,
    target: UserEntity | null,
  ): Promise<string | null> {
    if (!actor) return 'actor_missing';
    if (actor.isSuperAdmin !== true) return 'actor_not_staff';
    if (actor.suspendedAt) return 'actor_suspended';
    if (actor.sessionVersion !== handoff.actor_session_version) return 'actor_session_version';
    if (!(await this.staffSessions.isUsable(handoff.staff_session_id, actor.id))) return 'staff_session_ended';
    if (!target) return 'tenant_missing';
    if (target.suspendedAt) return 'tenant_suspended';
    if (target.isSuperAdmin) return 'tenant_super_admin';
    return null;
  }

  /** For `admin:revoke`: a staff member who is no longer staff leaves no code that works. */
  static async deleteUnused(
    manager: { query: (sql: string, params: unknown[]) => Promise<unknown> },
    actorId: string,
  ): Promise<void> {
    await manager.query(`DELETE FROM impersonation_handoffs WHERE actor_id = $1 AND used_at IS NULL`, [actorId]);
  }
}
