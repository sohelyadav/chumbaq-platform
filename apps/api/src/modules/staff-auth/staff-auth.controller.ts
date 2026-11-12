import { TripwiresService } from '../security-alerts/tripwires.service';
import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type {
  StaffLoginResult,
  StaffProfile,
  StaffReauthenticated,
  StaffRefreshed,
  StaffSignedIn,
} from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import type { RequestContext } from '../auth-events/auth-events.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ClientHeaderGuard } from '../auth/guards/client-header.guard';
import { AllowEnrolmentSession } from './allow-enrolment-session.decorator';
import {
  StaffCodeDto,
  StaffHandleDto,
  StaffLoginDto,
  StaffPasskeyLoginDto,
  StaffPasskeyVerifyDto,
  StaffPasswordlessDto,
  StaffTotpLoginDto,
} from './dto/staff-auth.dto';
import { StaffAuthService, StaffSignInResult } from './staff-auth.service';
import { StaffCookiesService } from './staff-cookies.service';
import { StaffJwtAuthGuard } from './staff-jwt-auth.guard';
import { STAFF_SESSION_ENDED_MESSAGE } from './staff-messages';
import { StaffPasskeysService } from './staff-passkeys.service';
import type { AuthenticatedStaff } from './staff-principal';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

/**
 * Staff sign-in, session and re-authentication on the admin API. Routes that set or
 * read the refresh cookie need the client header, as on the customer API.
 */
@Controller('staff/auth')
export class StaffAuthController {
  constructor(
    private readonly staffAuth: StaffAuthService,
    private readonly passkeys: StaffPasskeysService,
    private readonly cookies: StaffCookiesService,
    private readonly tripwires: TripwiresService,
  ) {}

  private signedIn(res: Response, result: StaffSignInResult): StaffSignedIn {
    this.cookies.deliver(res, result.refreshToken, result.sessionEndsAt);
    return result.body;
  }

  @Post('login')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  login(@Body() dto: StaffLoginDto, @Req() req: Request): Promise<StaffLoginResult> {
    this.tripwires.checkEmailLater(dto.email, 'sign_in', contextOf(req).ipAddress ?? null);
    return this.staffAuth.login(dto.email, dto.password, contextOf(req), dto.enrolmentCode);
  }

  @Post('login/totp')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async loginTotp(
    @Body() dto: StaffTotpLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffSignedIn> {
    return this.signedIn(res, await this.staffAuth.loginWithTotp(dto.handle, dto.code, contextOf(req)));
  }

  @Post('login/passkey/options')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  loginPasskeyOptions(@Body() dto: StaffHandleDto, @Req() req: Request) {
    return this.passkeys.secondFactorOptions(dto.handle, contextOf(req));
  }

  @Post('login/passkey/verify')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async loginPasskeyVerify(
    @Body() dto: StaffPasskeyLoginDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffSignedIn> {
    return this.signedIn(res, await this.passkeys.verifySecondFactor(dto.handle, dto.response, contextOf(req)));
  }

  @Post('passkey/options')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  passwordlessOptions() {
    return this.passkeys.passwordlessOptions();
  }

  @Post('passkey/verify')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async passwordlessVerify(
    @Body() dto: StaffPasswordlessDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StaffSignedIn> {
    return this.signedIn(res, await this.passkeys.verifyPasswordless(dto.ceremonyId, dto.response, contextOf(req)));
  }

  // The cookie is the only source of the token. A reload of the admin app restores its
  // session here; idleness is not reset by this, only by real requests.
  @Post('session/refresh')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 60 } })
  async refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<StaffRefreshed> {
    const token = this.cookies.read(req);
    if (!token) throw new UnauthorizedException(STAFF_SESSION_ENDED_MESSAGE);
    try {
      const result = await this.staffAuth.refresh(token, contextOf(req));
      if (result.refreshToken) this.cookies.deliver(res, result.refreshToken, result.sessionEndsAt);
      return result.body;
    } catch (error) {
      // A refusal is final, so the browser need not keep sending this. An outage is not.
      if (error instanceof HttpException && [401, 403].includes(error.getStatus())) this.cookies.clear(res);
      throw error;
    }
  }

  @Post('session/logout')
  @UseGuards(ClientHeaderGuard, StaffJwtAuthGuard)
  @AllowEnrolmentSession()
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(
    @CurrentUser() staff: AuthenticatedStaff,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    await this.staffAuth.logout(staff, contextOf(req));
    this.cookies.clear(res);
  }

  @Get('me')
  @UseGuards(StaffJwtAuthGuard)
  @AllowEnrolmentSession()
  me(@CurrentUser() staff: AuthenticatedStaff): Promise<StaffProfile> {
    return this.staffAuth.profile(staff);
  }

  @Post('reauth/passkey/options')
  @UseGuards(StaffJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  reauthPasskeyOptions(@CurrentUser() staff: AuthenticatedStaff) {
    return this.passkeys.reauthOptions(staff);
  }

  @Post('reauth/passkey/verify')
  @UseGuards(StaffJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  reauthPasskeyVerify(
    @CurrentUser() staff: AuthenticatedStaff,
    @Body() dto: StaffPasskeyVerifyDto,
    @Req() req: Request,
  ): Promise<StaffReauthenticated> {
    return this.passkeys.verifyReauth(staff, dto.response, contextOf(req));
  }

  @Post('reauth/totp')
  @UseGuards(StaffJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  reauthTotp(
    @CurrentUser() staff: AuthenticatedStaff,
    @Body() dto: StaffCodeDto,
    @Req() req: Request,
  ): Promise<StaffReauthenticated> {
    return this.staffAuth.reauthWithTotp(staff, dto.code, contextOf(req));
  }
}
