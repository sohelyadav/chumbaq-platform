import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import type {
  AccountActivityResponse,
  AccountActivityType,
  AccountSession,
} from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { DEFAULT_REFRESH_LIFETIME_MS, DEFAULT_SESSION_MAX_AGE_MS } from '../../config/jwt.config';
import {
  ACCOUNT_HISTORY_DAYS,
  AuthEventsService,
  RequestContext,
} from '../auth-events/auth-events.service';
import { UsersService } from '../users/users.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { deviceFamily, SessionsService } from './sessions.service';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

/**
 * Where an account is signed in, and what has happened to it. Staff looking through an
 * account see neither: addresses and devices are the person's own, and impersonation
 * is for seeing their workspace. The DELETEs get the read-only 403 from JwtStrategy.
 */
@Controller('auth')
@UseGuards(JwtAuthGuard)
export class AccountSessionsController {
  constructor(
    private readonly sessions: SessionsService,
    private readonly events: AuthEventsService,
    private readonly users: UsersService,
    private readonly config: ConfigService,
  ) {}

  @Get('sessions')
  async list(@CurrentUser() user: AuthenticatedUser): Promise<AccountSession[]> {
    refuseImpersonation(user);
    const account = await this.users.findById(user.userId);
    if (!account) throw new UnauthorizedException('User not found');
    const rows = await this.sessions.listLive(
      user.userId,
      account.sessionVersion,
      this.config.get<number>('jwt.refreshLifetimeMs', DEFAULT_REFRESH_LIFETIME_MS),
      this.config.get<number>('jwt.sessionMaxAgeMs', DEFAULT_SESSION_MAX_AGE_MS),
    );
    return rows.map((row) => ({
      id: row.id,
      device: deviceFamily(row.userAgent),
      ipAddress: row.ipAddress,
      signedInAt: row.createdAt.toISOString(),
      lastActiveAt: row.lastUsedAt.toISOString(),
      current: row.id === user.sessionId,
    }));
  }

  /** Ends another device's session at its next request. */
  @Delete('sessions/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revoke(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Req() req: Request,
  ): Promise<void> {
    if (id === user.sessionId) {
      throw new BadRequestException('To sign out of this device, use Sign out.');
    }
    if (!(await this.sessions.revoke(id, user.userId))) {
      throw new NotFoundException('That session has already ended.');
    }
    await this.events.record({
      type: 'session.revoked',
      userId: user.userId,
      email: user.email,
      sessionId: user.sessionId,
      ...contextOf(req),
    });
  }

  /** Every session but this one. */
  @Delete('sessions')
  @HttpCode(HttpStatus.NO_CONTENT)
  async revokeOthers(@CurrentUser() user: AuthenticatedUser, @Req() req: Request): Promise<void> {
    // A token from before sessions had rows cannot say which one to keep.
    if (!user.sessionId) {
      throw new BadRequestException('Sign in again first, then try this.');
    }
    const ended = await this.sessions.revokeOthers(user.userId, user.sessionId);
    if (ended === 0) return;
    await this.events.record({
      type: 'sessions.revoked_others',
      userId: user.userId,
      email: user.email,
      sessionId: user.sessionId,
      ...contextOf(req),
    });
  }

  @Get('activity')
  async activity(@CurrentUser() user: AuthenticatedUser): Promise<AccountActivityResponse> {
    refuseImpersonation(user);
    const rows = await this.events.history(user.userId);
    return {
      days: ACCOUNT_HISTORY_DAYS,
      activity: rows.map((row) => ({
        id: row.id,
        type: row.type as AccountActivityType,
        device: deviceFamily(row.userAgent),
        ipAddress: row.ipAddress,
        at: row.createdAt.toISOString(),
        current: row.sessionId !== null && row.sessionId === user.sessionId,
      })),
    };
  }
}

// A GET, so the read-only rule would let an impersonation token through without this.
function refuseImpersonation(user: AuthenticatedUser): void {
  if (user.impersonatedBy) throw new ForbiddenException('Impersonation sessions are read-only');
}
