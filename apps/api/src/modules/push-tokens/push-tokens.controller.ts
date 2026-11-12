import {
  Controller,
  Post,
  Delete,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { PushTokensService } from './push-tokens.service';
import { RegisterPushTokenDto } from './dto/register-token.dto';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { ChannelProviderRegistry } from '../push-notifications/services/channel-provider.registry';

@Controller('push-tokens')
export class PushTokensController {
  constructor(
    private readonly pushTokensService: PushTokensService,
    private readonly channelRegistry: ChannelProviderRegistry,
  ) {}

  @Post('register')
  @UseGuards(ApiKeyGuard)
  async registerToken(@Body() dto: RegisterPushTokenDto, @Req() req: Request) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId || dto.projectId !== apiKeyProjectId) {
      throw new ForbiddenException('Project mismatch');
    }

    // Refused here rather than accepted and stranded. A token outranks FCM the
    // moment it is stored — vendor channels are preferred by design — so
    // accepting one this build cannot deliver on would make the device pick a
    // channel with no provider behind it. The send would then fail, the
    // provider would call the token dead, and a reachable device would be
    // deactivated and counted toward uninstalls.
    const provider = dto.provider ?? 'fcm';
    if (!this.channelRegistry.supports(provider)) {
      throw new BadRequestException(
        `This deployment cannot deliver on the "${provider}" channel. ` +
          `Supported: ${this.channelRegistry.supported().join(', ')}.`,
      );
    }

    return this.pushTokensService.registerToken(dto);
  }

  @Delete('unregister')
  @UseGuards(ApiKeyGuard)
  async unregisterToken(
    @Query('projectId') projectId: string,
    @Query('token') token: string,
    @Req() req: Request,
  ) {
    const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
    if (!apiKeyProjectId || projectId !== apiKeyProjectId) {
      throw new ForbiddenException('Project mismatch');
    }
    await this.pushTokensService.unregisterToken(projectId, token);
    return { success: true };
  }
}
