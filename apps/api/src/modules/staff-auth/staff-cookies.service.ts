import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request, Response } from 'express';
import { SessionCookie } from '../../common/cookies';

/** `__Host-chumbaq_staff_refresh` on `Path=/` when Secure; see `SessionCookie`. */
export const STAFF_REFRESH_COOKIE = 'chumbaq_staff_refresh';
/** The path of the bare name, used only while Secure is off. */
export const STAFF_REFRESH_COOKIE_PATH = '/api/staff/auth/session';

/**
 * The staff refresh token, in an HttpOnly cookie so no script on the admin app can read
 * it. Host-only (`__Host-`, no Domain), so it goes to the admin host and nowhere else,
 * never to the customer app's, and no other host can plant one. SameSite=Strict and the client header on every route that sets or
 * reads it, as for the customer cookie.
 */
@Injectable()
export class StaffCookiesService {
  constructor(private readonly config: ConfigService) {}

  private cookie(): SessionCookie {
    return new SessionCookie(
      STAFF_REFRESH_COOKIE,
      STAFF_REFRESH_COOKIE_PATH,
      this.config.get<boolean>('staff.cookieSecure') ?? true,
    );
  }

  /** Lives until the session's absolute end, which refreshing never moves. */
  deliver(res: Response, refreshToken: string, expiresAt: Date): void {
    this.cookie().set(res, refreshToken, Math.max(0, expiresAt.getTime() - Date.now()));
  }

  clear(res: Response): void {
    this.cookie().clear(res);
  }

  read(req: Request): string | undefined {
    return this.cookie().read(req);
  }
}
