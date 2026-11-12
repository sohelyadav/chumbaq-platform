import {
  Controller,
  Post,
  Body,
  Param,
  UseGuards,
  ParseUUIDPipe,
} from '@nestjs/common';
import { EmailLinksService } from './email-links.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';

@Controller('projects/:projectId/email-links')
@UseGuards(JwtAuthGuard)
export class EmailLinksController {
  constructor(private readonly emailLinksService: EmailLinksService) {}

  @RequireProjectPermission('messaging.write')
  @Post('rewrite')
  async rewriteLinks(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body('html') html: string,
  ) {
    const rewritten = await this.emailLinksService.rewriteHtml(projectId, html);
    return { html: rewritten };
  }
}
