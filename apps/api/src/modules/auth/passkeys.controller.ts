import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
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
import {
  PasskeyHandleDto,
  PasskeyPasswordlessDto,
  PasskeyRegisterDto,
  PasskeySecondFactorDto,
  PasskeyVerifyDto,
} from './dto/passkey.dto';
import { ClientHeaderGuard } from './guards/client-header.guard';
import { JwtAuthGuard } from './guards/jwt-auth.guard';
import { RecentAuthGuard } from './guards/recent-auth.guard';
import { PasskeysService } from './passkeys.service';
import type { AuthenticatedUser } from './strategies/jwt.strategy';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

/** Staff looking through a tenant's eyes have no business with their sign-in methods. */
const refuseImpersonator = (user: AuthenticatedUser) => {
  if (user.impersonatedBy) throw new ForbiddenException('Impersonation sessions are read-only');
};

@Controller('auth')
export class PasskeysController {
  constructor(
    private readonly passkeys: PasskeysService,
    private readonly cookies: AuthCookiesService,
  ) {}

  // A GET, so the read-only rule would let an impersonation token through without the check.
  @Get('passkeys')
  @UseGuards(JwtAuthGuard)
  list(@CurrentUser() user: AuthenticatedUser) {
    refuseImpersonator(user);
    return this.passkeys.list(user.userId);
  }

  @Post('passkeys/options')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  registrationOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeys.registrationOptions(user);
  }

  @Post('passkeys')
  @Header('Cache-Control', 'no-store')
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  register(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PasskeyRegisterDto,
    @Req() req: Request,
  ) {
    return this.passkeys.register(user, dto.response, dto.name, contextOf(req));
  }

  @Delete('passkeys/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, RecentAuthGuard)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ) {
    await this.passkeys.remove(user, id, contextOf(req));
  }

  @Post('login/passkey/options')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  secondFactorOptions(@Body() dto: PasskeyHandleDto, @Req() req: Request) {
    return this.passkeys.secondFactorOptions(dto.handle, contextOf(req));
  }

  @Post('login/passkey/verify')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async verifySecondFactor(
    @Body() dto: PasskeySecondFactorDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookies.deliverSignIn(
      res,
      await this.passkeys.verifySecondFactor(dto.handle, dto.response, contextOf(req)),
    );
  }

  @Post('passkey/options')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  passwordlessOptions() {
    return this.passkeys.passwordlessOptions();
  }

  // Its own throttle bucket: the sign-in page asks on every load and again before the
  // challenge expires, which must not use up the button's allowance.
  @Post('passkey/autofill-options')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  autofillOptions() {
    return this.passkeys.autofillOptions();
  }

  @Post('passkey/verify')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async verifyPasswordless(
    @Body() dto: PasskeyPasswordlessDto,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ) {
    return this.cookies.deliverSignIn(
      res,
      await this.passkeys.verifyPasswordless(dto.flowId, dto.response, contextOf(req)),
    );
  }

  @Post('reauth/passkey/options')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  reauthOptions(@CurrentUser() user: AuthenticatedUser) {
    return this.passkeys.reauthOptions(user);
  }

  @Post('reauth/passkey/verify')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  verifyReauth(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PasskeyVerifyDto,
    @Req() req: Request,
  ) {
    return this.passkeys.verifyReauth(user, dto.response, contextOf(req));
  }
}
