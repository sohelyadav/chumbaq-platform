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
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import { getClientIp } from '../../common/client-ip';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { StaffJwtAuthGuard } from '../staff-auth/staff-jwt-auth.guard';
import { AdminTenantsService } from './admin-tenants.service';
import {
  AdminProjectLimitDto,
  AdminSeatLimitDto,
  AdminTenantReasonDto,
  ListAdminTenantsDto,
} from './dto/admin-tenants.dto';
import { StaffRecentAuthGuard } from '../staff-auth/staff-recent-auth.guard';
import { SuperAdminGuard } from './guards/super-admin.guard';

@Controller('admin')
@UseGuards(StaffJwtAuthGuard, SuperAdminGuard)
export class AdminTenantsController {
  constructor(private readonly tenantsService: AdminTenantsService) {}

  @Get('tenants')
  list(@Query() query: ListAdminTenantsDto) {
    return this.tenantsService.list(query);
  }

  @Get('tenants/:id')
  findOne(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ) {
    return this.tenantsService.view(id, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }

  // A deliberate, reasoned human action: well under the global 100/min, but
  // loose enough to work through a batch of abusive accounts.
  @Post('tenants/:id/suspend')
  @UseGuards(StaffRecentAuthGuard)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  suspend(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminTenantReasonDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ) {
    return this.tenantsService.suspend(id, dto.reason, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }

  // SuperAdminGuard (on the class) refuses impersonation tokens and non-staff.
  @Patch('tenants/:id/project-limit')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  setProjectLimit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminProjectLimitDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ) {
    return this.tenantsService.setProjectLimit(id, dto.projectLimit, dto.reason, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }

  @Patch('tenants/:id/seat-limit')
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  setSeatLimit(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminSeatLimitDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ) {
    return this.tenantsService.setSeatLimit(id, dto.seatLimit, dto.reason, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }

  @Post('tenants/:id/reactivate')
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { ttl: 60_000, limit: 20 } })
  reactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdminTenantReasonDto,
    @CurrentUser() user: { userId: string; email: string },
    @Req() request: Request,
  ) {
    return this.tenantsService.reactivate(id, dto.reason, {
      userId: user.userId,
      email: user.email,
      ipAddress: getClientIp(request),
    });
  }
}
