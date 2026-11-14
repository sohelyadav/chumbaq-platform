import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Request, Response } from 'express';
import { SessionCookie } from '../../common/cookies';
import type { AuthTokens } from './auth.service';

/** `__Host-chumbaq_refresh` on `Path=/` when Secure; see `SessionCookie`. */
const REFRESH_COOKIE = 'chumbaq_refresh';
/** The path of the bare name, used only while Secure is off. */
const REFRESH_COOKIE_PATH = '/api/auth';

/**
 * A simple cross-site form cannot set a custom header, so requiring one on the routes
 * that accept the cookie is a second lock behind SameSite=Strict.
 */
export const CLIENT_HEADER = 'x-chumbaq-client';

/**
 * The refresh token lives in an HttpOnly cookie, so script on the page, including an
 * injected one, cannot read it, and no longer appears in any response body.
 */
@Injectable()
export class AuthCookiesService {
  constructor(
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  private cookie(): SessionCookie {
    return new SessionCookie(
      REFRESH_COOKIE,
      REFRESH_COOKIE_PATH,
      this.config.get<boolean>('app.authCookieSecure') ?? true,
    );
  }

  /** Sets the cookie and returns what may go in the response body. */
  deliver(res: Response, tokens: AuthTokens): { accessToken: string } {
    const { exp } = this.jwt.decode<{ exp: number }>(tokens.refreshToken);
    this.cookie().set(res, tokens.refreshToken, exp * 1000 - Date.now());
    return { accessToken: tokens.accessToken };
  }

  deliverSignIn<T extends { tokens: AuthTokens }>(
    res: Response,
    signedIn: T,
  ): Omit<T, 'tokens'> & { tokens: { accessToken: string } } {
    return { ...signedIn, tokens: this.deliver(res, signedIn.tokens) };
  }

  clear(res: Response): void {
    this.cookie().clear(res);
  }

  read(req: Request): string | undefined {
    return this.cookie().read(req);
  }
}
