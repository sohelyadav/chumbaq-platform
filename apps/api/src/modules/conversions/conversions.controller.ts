import {
  Controller,
  Post,
  Body,
  UseGuards,
  Req,
  ForbiddenException,
} from '@nestjs/common';
import { Request } from 'express';
import { ConversionsService } from './conversions.service';
import { CreateConversionDto } from './dto/create-conversion.dto';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';

@Controller('conversions')
export class ConversionsController {
  constructor(private readonly conversionsService: ConversionsService) {}

  @Post()
  @UseGuards(ApiKeyGuard)
  async trackConversion(@Body() dto: CreateConversionDto, @Req() req: Request) {
    const expectedProjectId = (req as Request & { projectId?: string }).projectId;
    // `projectId` in the body is optional — the JS SDK omits it, the native
    // SDKs send it. When it is there it must agree with the key, the same
    // check `POST /api/identity/revenue` makes.
    if (dto.projectId && dto.projectId !== expectedProjectId) {
      throw new ForbiddenException('Project mismatch');
    }
    // `{ recorded: false }` when the person is do-not-track: still a 2xx.
    return (
      (await this.conversionsService.trackConversion(dto, expectedProjectId)) ?? {
        recorded: false,
      }
    );
  }
}
