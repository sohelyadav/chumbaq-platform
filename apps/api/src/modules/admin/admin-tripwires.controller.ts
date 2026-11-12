import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { IsEmail, IsString, Length } from 'class-validator';
import type { Request } from 'express';
import type { TripwireView } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { TripwiresService } from '../security-alerts/tripwires.service';
import { AdminAuditService } from './admin-audit.service';
import { SuperAdminGuard } from './guards/super-admin.guard';

export class CreateTripwireKeyDto {
  @IsString()
  @Length(1, 100)
  label!: string;
}

export class CreateTripwireAccountDto extends CreateTripwireKeyDto {
  @IsEmail()
  email!: string;
}

type Staff = { userId: string; email: string };

/** Trap API keys and trap accounts, for the Incidents page. Every change is audited. */
@Controller('admin/tripwires')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminTripwiresController {
  constructor(
    private readonly tripwires: TripwiresService,
    private readonly audit: AdminAuditService,
  ) {}

  @Get()
  list(): Promise<TripwireView[]> {
    return this.tripwires.list();
  }

  /** The key is in this answer only; only its hash is kept. */
  @Post('api-key')
  @UseGuards(StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async createApiKey(@Body() dto: CreateTripwireKeyDto, @CurrentUser() staff: Staff, @Req() req: Request) {
    const created = await this.tripwires.createApiKey(dto.label, staff.userId);
    await this.record('tripwire.created', created.id, dto.label, { kind: 'api_key' }, staff, req);
    return created;
  }

  @Post('account')
  @UseGuards(StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  async createAccount(@Body() dto: CreateTripwireAccountDto, @CurrentUser() staff: Staff, @Req() req: Request) {
    const created = await this.tripwires.createAccount(dto.email, dto.label, staff.userId);
    await this.record('tripwire.created', created.id, dto.label, { kind: 'account' }, staff, req);
    return created;
  }

  @Post(':id/revoke')
  @UseGuards(StaffRecentAuthGuard)
  async revoke(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() staff: Staff, @Req() req: Request) {
    const trap = await this.tripwires.revoke(id);
    await this.record('tripwire.revoked', id, trap.label, { kind: trap.kind }, staff, req);
    return { revoked: true };
  }

  private async record(
    action: 'tripwire.created' | 'tripwire.revoked',
    id: string,
    label: string,
    metadata: Record<string, unknown>,
    staff: Staff,
    req: Request,
  ): Promise<void> {
    await this.audit.record({
      actorId: staff.userId,
      actorEmail: staff.email,
      action,
      targetType: 'tripwire',
      targetId: id,
      targetLabel: label,
      metadata,
      ipAddress: getClientIp(req),
    });
  }
}
