import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AdminPlan } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BillingEnabledGuard } from '../billing/billing-enabled.guard';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { AdminPlansService } from './admin-plans.service';
import { AdminActor } from './admin-tenants.service';
import { AdminAddPriceDto, AdminCreatePlanDto, AdminPlanReasonDto, AdminUpdatePlanDto } from './dto/admin-plans.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

type Staff = { userId: string; email: string };

function actorOf(user: Staff, request: Request): AdminActor {
  return { userId: user.userId, email: user.email, ipAddress: getClientIp(request) };
}

/**
 * Plans and prices. Plans list and edit with billing off, so staff can set limits
 * before switching it on; prices are checked against the provider and so exist only
 * with billing on (404 otherwise, after the staff guards).
 */
@Controller('admin/plans')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminPlansController {
  constructor(private readonly plans: AdminPlansService) {}

  @Get()
  list(): Promise<AdminPlan[]> {
    return this.plans.list();
  }

  @Post()
  @UseGuards(StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  create(@Body() dto: AdminCreatePlanDto, @CurrentUser() user: Staff, @Req() request: Request): Promise<AdminPlan> {
    return this.plans.create(dto, actorOf(user, request));
  }

  @Patch(':code')
  @UseGuards(StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  update(
    @Param('code') code: string,
    @Body() dto: AdminUpdatePlanDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminPlan> {
    return this.plans.update(code, dto, actorOf(user, request));
  }

  @Post(':code/prices')
  @UseGuards(BillingEnabledGuard, StaffRecentAuthGuard)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  addPrice(
    @Param('code') code: string,
    @Body() dto: AdminAddPriceDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminPlan> {
    return this.plans.addPrice(code, dto, actorOf(user, request));
  }

  @Post(':code/prices/:id/retire')
  @UseGuards(BillingEnabledGuard, StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  retirePrice(
    @Param('code') code: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminPlanReasonDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminPlan> {
    return this.plans.retirePrice(code, id, dto.reason, actorOf(user, request));
  }
}
