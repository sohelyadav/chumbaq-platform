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
    const entries = Object.entries(dto.details ?? {});
    if (entries.length > MAX_DETAILS) throw new BadRequestException(`At most ${MAX_DETAILS} details`);
    if (entries.some(([, value]) => typeof value !== 'string')) {
      throw new BadRequestException('Details must be text');
    }
    // Shortened, never refused: the scripts discard a refusal, so refusing a long value
    // (AIDE's list of changed files) dropped the alarm without a trace.
    const details = Object.fromEntries(
      entries.map(([name, value]) => {
        const text = value as string;
        return [name, text.length > MAX_DETAIL_LENGTH ? `${text.slice(0, MAX_DETAIL_LENGTH - 1)}…` : text];
      }),
    );
    await this.alerts.raise(dto.kind, dto.key, details, dto.ip ?? null);
    return { accepted: true };
  }
}
