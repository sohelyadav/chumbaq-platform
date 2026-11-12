import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { getClientIp } from '../../common/client-ip';
import type { RequestContext } from '../auth-events/auth-events.service';
import { AuthCookiesService } from './auth-cookies.service';
import { CurrentUser } from './decorators/current-user.decorator';
import { FactorCodeDto, LoginFactorCodeDto } from './dto/totp.dto';
import { ClientHeaderGuard } from './guards/client-header.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RecentAuthGuard } from './guards/recent-auth.guard';
import type { AuthenticatedUser } from './strategies/jwt.strategy';
import { TotpService } from './totp.service';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

@Controller('auth')
export class TotpController {
  constructor(
    private readonly totp: TotpService,
    private readonly cookies: AuthCookiesService,
  ) {}

  // A GET, so the read-only rule would let an impersonation token through without the check.
  @Get('factors')
  @UseGuards(JwtAuthGuard)
  status(@CurrentUser() user: AuthenticatedUser) {
    if (user.impersonatedBy) throw new ForbiddenException('Impersonation sessions are read-only');
    return this.totp.status(user.userId);
  }

  @Post('totp/setup')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  setup(@CurrentUser() user: AuthenticatedUser) {
    return this.totp.setup(user);
  }

  @Post('totp/confirm')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  confirm(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FactorCodeDto,
    @Req() req: Request,
  ) {
    return this.totp.confirm(user, dto.code, contextOf(req));
  }

  @Delete('totp')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  async disable(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    await this.totp.disable(user, contextOf(req));
  }

  @Post('recovery-codes')
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  regenerate(@CurrentUser() user: AuthenticatedUser, @Req() req: Request) {
    return this.totp.regenerateRecoveryCodes(user, contextOf(req));
  }

  @Post('login/totp')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async verifySignIn(
    @Body() dto: LoginFactorCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookies.deliverSignIn(
      res,
      await this.totp.verifyTotpSignIn(dto.handle, dto.code, contextOf(req)),
    );
  }

  @Post('login/recovery-code')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async verifyRecoverySignIn(
    @Body() dto: LoginFactorCodeDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookies.deliverSignIn(
      res,
      await this.totp.verifyRecoverySignIn(dto.handle, dto.code, contextOf(req)),
    );
  }

  @Post('reauth/totp')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  reauth(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FactorCodeDto,
    @Req() req: Request,
  ) {
    return this.totp.reauthWithTotp(user, dto.code, contextOf(req));
  }

  @Post('reauth/recovery-code')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  reauthWithRecoveryCode(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: FactorCodeDto,
    @Req() req: Request,
  ) {
    return this.totp.reauthWithRecoveryCode(user, dto.code, contextOf(req));
  }
}
