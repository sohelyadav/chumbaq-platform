import { TripwiresService } from '../security-alerts/tripwires.service';
import {
  Controller,
  Post,
  Get,
  Body,
  UseGuards,
  HttpCode,
  HttpStatus,
  Req,
  Res,
  HttpException,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { ResendVerificationResponse } from '@chumbaq/shared';
import { AuthCookiesService } from './auth-cookies.service';
import { AuthService } from './auth.service';
import { AccountRecoveryService, FORGOT_PASSWORD_MESSAGE } from './account-recovery.service';
import { VerifyEmailDto } from './dto/verify-email.dto';
import { ForgotPasswordDto } from './dto/forgot-password.dto';
import { ResetLinkStatusDto, ResetPasswordDto } from './dto/reset-password.dto';
import { ReauthDto } from './dto/reauth.dto';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { ClientHeaderGuard } from './guards/client-header.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { CurrentUser } from './decorators/current-user.decorator';
import type { AuthenticatedUser } from './strategies/jwt.strategy';
import { getClientIp } from '../../common/client-ip';
import type { RequestContext } from '../auth-events/auth-events.service';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly recovery: AccountRecoveryService,
    private readonly cookies: AuthCookiesService,
    private readonly tripwires: TripwiresService,
  ) {}

  // Stricter throttle on credential-touching endpoints — 5 attempts/min/IP.
  // The global ThrottlerGuard is bound in app.module.ts; @Throttle here
  // overrides the default 100/min for these specific routes.
  @Post('register')
  @UseGuards(ClientHeaderGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async register(
    @Body() dto: RegisterDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookies.deliverSignIn(res, await this.authService.register(dto, contextOf(req)));
  }

  @Post('login')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async login(
    @Body() dto: LoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    // Not awaited: an unknown address's answer must not wait on, or differ for, a trap.
    this.tripwires.checkEmailLater(dto.email, 'sign_in', getClientIp(req));
    const result = await this.authService.login(dto, contextOf(req));
    return 'tokens' in result ? this.cookies.deliverSignIn(res, result) : result;
  }

  // The cookie is the only source of the token. The header is still needed because this route
  // sets the cookie, and SameSite stops a cookie being sent but not being set: a cross-site
  // form must not be able to reach a route that writes one.
  @Post('refresh')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  // Every page load refreshes now, since the access token is held only in memory.
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    const token = this.cookies.read(req);
    if (!token) throw new UnauthorizedException('Invalid or expired refresh token');

    try {
      return this.cookies.deliver(res, await this.authService.refresh(token, contextOf(req)));
    } catch (error) {
      // A refusal is final, so the browser need not keep sending this. An outage is not.
      if (error instanceof HttpException && [401, 403].includes(error.getStatus())) {
        this.cookies.clear(res);
      }
      throw error;
    }
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logout(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logout(user, contextOf(req));
    this.cookies.clear(res);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard)
  async logoutAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.authService.logoutAll(user, contextOf(req));
    this.cookies.clear(res);
  }

  // A POST, so an impersonation token gets the read-only 403 from JwtStrategy.
  @Post('reauth')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async reauth(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReauthDto,
    @Req() req: Request,
  ) {
    return this.authService.reauthenticate(user, dto.password, contextOf(req));
  }

  // A POST, so an impersonation token gets the read-only 403 from JwtStrategy.
  @Post('verify-email')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async verifyEmail(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: VerifyEmailDto,
    @Req() req: Request,
  ) {
    await this.recovery.verifyEmail(dto.token, user.userId, contextOf(req));
    return { verified: true };
  }

  // A POST, so an impersonation token gets the read-only 403 from JwtStrategy.
  @Post('resend-verification')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 3 } })
  async resendVerification(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ResendVerificationResponse> {
    return { status: await this.recovery.resendVerification(user.userId) };
  }

  @Post('forgot-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  forgotPassword(@Body() dto: ForgotPasswordDto, @Req() req: Request) {
    this.tripwires.checkEmailLater(dto.email, 'password_reset', getClientIp(req));
    this.recovery.requestPasswordReset(dto.email, contextOf(req));
    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  @Post('reset-password')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async resetPassword(@Body() dto: ResetPasswordDto, @Req() req: Request) {
    await this.recovery.resetPassword(dto.token, dto.newPassword, contextOf(req));
    return { message: 'Password updated.' };
  }

  /** Before the form: whether this is a staff link still waiting, and until when. */
  @Post('reset-password/status')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  resetPasswordStatus(@Body() dto: ResetLinkStatusDto) {
    return this.recovery.resetLinkStatus(dto.token);
  }

  @Get('me')
  @UseGuards(JwtAuthGuard)
  async me(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.getProfile(user.userId, { impersonated: Boolean(user.impersonatedBy) });
  }
}
