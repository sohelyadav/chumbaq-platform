import { Controller, Post, Body, Req, UseGuards, ForbiddenException } from '@nestjs/common';
import { Request } from 'express';
import { DeferredMatchService } from './deferred-match.service';
import { DeferredMatchDto } from './dto/deferred-match.dto';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { getClientIp } from '../../common/client-ip';

@Controller('deferred')
export class DeferredMatchController {
  constructor(
    private readonly deferredMatchService: DeferredMatchService,
  ) {}

  @Post('match')
  @UseGuards(ApiKeyGuard)
  async match(@Body() dto: DeferredMatchDto, @Req() req: Request) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId) {
      throw new ForbiddenException('Missing API key context');
    }
    // The address is the request's to give, never the body's: see
    // FingerprintDto for what a caller-supplied one bought.
    return this.deferredMatchService.matchDeferred(
      dto,
      apiKeyProjectId,
      getClientIp(req),
    );
  }
}
