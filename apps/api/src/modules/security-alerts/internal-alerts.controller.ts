import { BadRequestException, Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { InternalAlertDto } from './dto/internal-alert.dto';
import { InternalAlertTokenGuard } from './internal-alert-token.guard';
import { SecurityAlertsService } from './security-alerts.service';

const MAX_DETAILS = 20;
const MAX_DETAIL_LENGTH = 500;

/**
 * Server scripts raise alarms here: an SSH login (pam_exec), a fail2ban ban, AIDE's
 * daily check. Only on the admin API, which listens on 127.0.0.1; nginx answers 404 for
 * /api/internal/ on every host, so nothing on the internet reaches it.
 */
@Controller('internal/security-alerts')
@UseGuards(InternalAlertTokenGuard)
export class InternalAlertsController {
  constructor(private readonly alerts: SecurityAlertsService) {}

  @Post()
  @HttpCode(202)
  async raise(@Body() dto: InternalAlertDto): Promise<{ accepted: true }> {
    const details = dto.details ?? {};
    const entries = Object.entries(details);
    if (entries.length > MAX_DETAILS) throw new BadRequestException(`At most ${MAX_DETAILS} details`);
    for (const [, value] of entries) {
      if (typeof value !== 'string' || value.length > MAX_DETAIL_LENGTH) {
        throw new BadRequestException(`Details must be text of at most ${MAX_DETAIL_LENGTH} characters`);
      }
    }
    await this.alerts.raise(dto.kind, dto.key, details as Record<string, string>, dto.ip ?? null);
    return { accepted: true };
  }
}
