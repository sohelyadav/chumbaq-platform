import {
  Body,
  Controller,
  Get,
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
import type { AdminBillingSummary, AdminTenantBilling } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { BillingEnabledGuard } from '../billing/billing-enabled.guard';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { AdminBillingService } from './admin-billing.service';
import { AdminActor } from './admin-tenants.service';
import { AdminCancelSubscriptionDto, AdminCompDto } from './dto/admin-billing.dto';
import { AdminTenantReasonDto } from './dto/admin-tenants.dto';
import { SuperAdminGuard } from './guards/super-admin.guard';

type Staff = { userId: string; email: string };

function actorOf(user: Staff, request: Request): AdminActor {
  return { userId: user.userId, email: user.email, ipAddress: getClientIp(request) };
}

/**
 * Staff billing: the summary, one tenant's billing and the actions on it. Every route
 * answers 404 while billing is off (after the staff guards, which every admin route
 * has first). Writes need a recent sign-in and a reason.
 */
@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard, BillingEnabledGuard)
export class AdminBillingController {
  constructor(private readonly billing: AdminBillingService) {}

  @Get('billing/summary')
  summary(): Promise<AdminBillingSummary> {
    return this.billing.summary();
  }

  @Get('tenants/:id/billing')
  tenant(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminTenantBilling> {
    return this.billing.viewTenant(id, actorOf(user, request));
  }

  @Post('tenants/:id/billing/comp')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  comp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminCompDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminTenantBilling> {
    return this.billing.comp(id, dto, actorOf(user, request));
  }

  @Post('tenants/:id/billing/comp/end')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  endComp(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminTenantReasonDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminTenantBilling> {
    return this.billing.endComp(id, dto.reason, actorOf(user, request));
  }

  @Post('tenants/:id/billing/cancel')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  cancel(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminCancelSubscriptionDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<AdminTenantBilling> {
    return this.billing.cancel(id, dto, actorOf(user, request));
  }

  @Post('tenants/:id/billing/invoices/:invoiceId/resend')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  resend(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('invoiceId', ParseUUIDPipe) invoiceId: string,
    @Body() dto: AdminTenantReasonDto,
    @CurrentUser() user: Staff,
    @Req() request: Request,
  ): Promise<{ resent: true }> {
    return this.billing.resendInvoice(id, invoiceId, dto.reason, actorOf(user, request));
  }
}
