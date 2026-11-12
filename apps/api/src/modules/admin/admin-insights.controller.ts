import {
  BadGatewayException,
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { AdminHealth, AdminOverview } from '@chumbaq/shared';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';
import { AdminInsightsService } from './admin-insights.service';
import { AdminTestEmailDto } from './dto/admin-test-email.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { PlatformEmailService } from '../platform-email/platform-email.service';

@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminInsightsController {
  constructor(
    private readonly insights: AdminInsightsService,
    private readonly platformEmail: PlatformEmailService,
  ) {}

  /** Proves the sender works before anyone depends on it to get back into an account. */
  @Post('platform-email/test')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 5 } })
  async testPlatformEmail(
    @CurrentUser('email') email: string,
    @Body() dto: AdminTestEmailDto,
  ): Promise<{ sentTo: string }> {
    const to = dto.to ?? email;
    const result = await this.platformEmail.send({
      to,
      subject: 'Chumbaq account email test',
      text: 'Account email is working. A super admin sent this test from Platform health.',
      html: '<p>Account email is working. A super admin sent this test from Platform health.</p>',
    });
    if (result.sent) return { sentTo: to };
    if (result.reason === 'not_configured') {
      throw new ConflictException('Set PLATFORM_BREVO_API_KEY and PLATFORM_EMAIL_FROM first');
    }
    throw new BadGatewayException('Brevo did not accept the email. The API log has the reason.');
  }

  @Get('overview')
  overview(): Promise<AdminOverview> {
    return this.insights.overview();
  }

  /** Always 200: a failing dependency is the answer, reported in the body. */
  @Get('health')
  health(): Promise<AdminHealth> {
    return this.insights.health();
  }
}
