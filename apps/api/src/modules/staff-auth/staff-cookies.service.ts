import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { readCookie } from '../../common/cookies';

export const STAFF_REFRESH_COOKIE = 'chumbaq_staff_refresh';
/** Only the refresh and logout routes ever receive it. */
export const STAFF_REFRESH_COOKIE_PATH = '/api/staff/auth/session';

/**
 * The staff refresh token, in an HttpOnly cookie so no script on the admin app can read
 * it. Host-only (no Domain), so it goes to the admin host and nowhere else, and never to
 * the customer app's. SameSite=Strict and the client header on every route that sets or
 * reads it, as for the customer cookie.
 */
@Injectable()
export class StaffCookiesService {
  constructor(private readonly config: ConfigService) {}

  private options() {
    return {
      httpOnly: true,
      secure: this.config.get<boolean>('staff.cookieSecure') ?? true,
      sameSite: 'strict' as const,
      path: STAFF_REFRESH_COOKIE_PATH,
    };
  }

  /** Lives until the session's absolute end, which refreshing never moves. */
  deliver(res: Response, refreshToken: string, expiresAt: Date): void {
    res.cookie(STAFF_REFRESH_COOKIE, refreshToken, {
      ...this.options(),
      maxAge: Math.max(0, expiresAt.getTime() - Date.now()),
    });
  }

  clear(res: Response): void {
    res.clearCookie(STAFF_REFRESH_COOKIE, this.options());
  }

  read(req: Request): string | undefined {
    return readCookie(req, STAFF_REFRESH_COOKIE);
  }
}
