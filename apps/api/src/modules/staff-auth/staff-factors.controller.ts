import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { StaffEnrolled, StaffFactors } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import type { RequestContext } from '../auth-events/auth-events.service';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { AllowEnrolmentSession } from './allow-enrolment-session.decorator';
import { StaffCodeDto, StaffPasskeyRegisterDto } from './dto/staff-auth.dto';
import { StaffFactorsService } from './staff-factors.service';
import { StaffJwtAuthGuard } from './staff-jwt-auth.guard';
import { StaffPasskeysService } from './staff-passkeys.service';
import type { AuthenticatedStaff } from './staff-principal';
import { StaffRecentAuthGuard } from './staff-recent-auth.guard';

const contextOf = (req: Request): RequestContext => ({
  ipAddress: getClientIp(req),
  userAgent: req.headers['user-agent'],
});

/**
 * A staff member's own sign-in methods. Adding is open to an enrolment-only session (its
 * whole purpose); a full session needs a recent re-authentication and its proof, checked
 * in the service because the rule depends on the session. Removing is never open to an
 * enrolment-only session.
 */
@Controller('staff/auth')
@UseGuards(StaffJwtAuthGuard)
export class StaffFactorsController {
  constructor(
    private readonly factors: StaffFactorsService,
    private readonly passkeys: StaffPasskeysService,
  ) {}

  @Get('factors')
  @AllowEnrolmentSession()
  list(@CurrentUser() staff: AuthenticatedStaff): Promise<StaffFactors> {
    return this.factors.list(staff);
  }

  @Post('passkeys/options')
  @AllowEnrolmentSession()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  passkeyOptions(@CurrentUser() staff: AuthenticatedStaff) {
    return this.passkeys.registrationOptions(staff);
  }

  @Post('passkeys')
  @AllowEnrolmentSession()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  addPasskey(
    @CurrentUser() staff: AuthenticatedStaff,
    @Body() dto: StaffPasskeyRegisterDto,
    @Req() req: Request,
  ): Promise<StaffEnrolled> {
    return this.passkeys.register(staff, dto.response, dto.name, contextOf(req));
  }

  @Delete('passkeys/:id')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removePasskey(
    @CurrentUser() staff: AuthenticatedStaff,
    @Param('id', ParseUUIDPipe) id: string,
    @Req() req: Request,
  ): Promise<void> {
    await this.passkeys.remove(staff, id, contextOf(req));
  }

  @Post('totp/setup')
  @AllowEnrolmentSession()
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  totpSetup(@CurrentUser() staff: AuthenticatedStaff) {
    return this.factors.totpSetup(staff);
  }

  @Post('totp/confirm')
  @AllowEnrolmentSession()
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  totpConfirm(
    @CurrentUser() staff: AuthenticatedStaff,
    @Body() dto: StaffCodeDto,
    @Req() req: Request,
  ): Promise<StaffEnrolled> {
    return this.factors.totpConfirm(staff, dto.code, contextOf(req));
  }

  @Delete('totp')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.NO_CONTENT)
  async removeTotp(@CurrentUser() staff: AuthenticatedStaff, @Req() req: Request): Promise<void> {
    await this.factors.totpRemove(staff, contextOf(req));
  }
}
