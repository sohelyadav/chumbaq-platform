import { Body, Controller, Header, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { AdminImpersonationSession } from '@chumbaq/shared';
import { getClientIp } from '../../common/client-ip';
import { ClientHeaderGuard } from '../auth/guards/client-header.guard';
import { ImpersonationExchangeDto } from './dto/exchange.dto';
import { ImpersonationHandoffsService } from './impersonation-handoffs.service';

/**
 * Customer API. The code arrives in the body, never the URL, so it is in no access log.
 * Unauthenticated: the staff member may not be signed in to the customer app at all, and
 * the code is what proves the view-as was asked for. The client header keeps another
 * site's form from posting one, as on the sign-in routes.
 */
@Controller('auth/impersonation')
export class ImpersonationExchangeController {
  constructor(private readonly handoffs: ImpersonationHandoffsService) {}

  @Post('exchange')
  @UseGuards(ClientHeaderGuard)
  @HttpCode(HttpStatus.OK)
  @Header('Cache-Control', 'no-store')
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  exchange(@Body() dto: ImpersonationExchangeDto, @Req() req: Request): Promise<AdminImpersonationSession> {
    return this.handoffs.exchange(dto.code, { ipAddress: getClientIp(req) });
  }
}
