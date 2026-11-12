import {
  Controller,
  Get,
  Post,
  Patch,
  Body,
  Param,
  Query,
  Req,
  UseGuards,
  NotFoundException,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  BadRequestException,
} from '@nestjs/common';
import { Request } from 'express';
import { IdentityService } from './identity.service';
import { IdentifyDto, UpdateConsentDto, TrackRevenueDto } from './dto/identify.dto';
import { LinkDeviceDto } from './dto/link-device.dto';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequireProjectPermission } from '../project-access/require-project-permission.decorator';
import { refuseViewAs, VIEW_AS_NOT_AVAILABLE } from '../project-access/view-as';
import { ApiKeyGuard } from '../api-keys/guards/api-key.guard';
import { getClientIp } from '../../common/client-ip';
import { RecentAuthGuard } from '../auth/guards/recent-auth.guard';
import type { AuthenticatedUser } from '../auth/strategies/jwt.strategy';
import { PersonObjectionsService } from '../consent/person-objections.service';
import { CreatePersonObjectionDto, PersonObjectionTargetDto } from '../consent/dto/person-objection.dto';
import { requesterOf } from '../project-activity/messaging-activity';

function assertProjectScope(req: Request, dtoProjectId: string): void {
  const apiKeyProjectId = (req as Request & { projectId?: string }).projectId;
  if (!apiKeyProjectId || dtoProjectId !== apiKeyProjectId) {
    throw new ForbiddenException('Project mismatch');
  }
}

@Controller('identity')
export class IdentityController {
  constructor(
    private readonly identityService: IdentityService,
    private readonly personObjections: PersonObjectionsService,
  ) {}

  @Post('identify')
  @UseGuards(ApiKeyGuard)
  async identify(@Body() dto: IdentifyDto, @Req() req: Request) {
    assertProjectScope(req, dto.projectId);
    return this.identityService.identify(dto, getClientIp(req));
  }

  @Post('link-device')
  @UseGuards(ApiKeyGuard)
  async linkDevice(@Body() body: LinkDeviceDto, @Req() req: Request) {
    assertProjectScope(req, body.projectId);
    return this.identityService.linkDevice(body, getClientIp(req));
  }

  @Post('merge')
  @UseGuards(ApiKeyGuard)
  async mergeIdentity(
    @Body() body: { projectId: string; anonymousId: string; identifiedId: string },
    @Req() req: Request,
  ) {
    assertProjectScope(req, body.projectId);
    await this.identityService.mergeIdentity(
      body.projectId,
      body.anonymousId,
      body.identifiedId,
    );
    return { success: true };
  }

  @Post('revenue')
  @UseGuards(ApiKeyGuard)
  async trackRevenue(@Body() dto: TrackRevenueDto, @Req() req: Request) {
    assertProjectScope(req, dto.projectId);
    await this.identityService.trackRevenue(dto);
    return { success: true };
  }

  @RequireProjectPermission('messaging.write')
  @UseGuards(JwtAuthGuard)
  @Patch('projects/:projectId/users/:personId/consent')
  async updateConsent(
    @Param('projectId') projectId: string,
    @Param('personId') personId: string,
    @Body() dto: UpdateConsentDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const result = await this.identityService.updateConsent(projectId, personId, dto, requesterOf(user.userId, req));
    if (!result) throw new NotFoundException('Person not found');
    return result;
  }

  /**
   * What a person-level do-not-track would cover, for the confirmation: the
   * exact external id and how many devices claim it now, and whether one is
   * in place. Needs the `privacy` permission (owner role).
   */
  @RequireProjectPermission('privacy')
  @UseGuards(JwtAuthGuard)
  @Get('projects/:projectId/tracking-objections/preview')
  async previewPersonObjection(
    @Param('projectId') projectId: string,
    @Query() query: PersonObjectionTargetDto,
  ) {
    return this.personObjections.preview(projectId, query.externalUserId);
  }

  /**
   * Turns do-not-track on for a whole person, named by external id. The only
   * way one is made: the row-level consent PATCH never creates one.
   */
  @RequireProjectPermission('privacy')
  @UseGuards(JwtAuthGuard)
  @Post('projects/:projectId/tracking-objections')
  async createPersonObjection(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePersonObjectionDto,
    @Req() req: Request,
  ) {
    refuseViewAs(user, VIEW_AS_NOT_AVAILABLE);
    return this.personObjections.object(
      projectId,
      dto.externalUserId,
      { userId: user.userId, sourceIdentityId: dto.sourceIdentityId ?? null },
      requesterOf(user.userId, req),
    );
  }

  /**
   * Lifts a person's do-not-track, named by external id. Needs a recent
   * sign-in: resuming tracking of someone who objected should not be one
   * click away for a stolen session.
   */
  // Guard order [JwtAuthGuard, ProjectAccessGuard, RecentAuthGuard]: decorators apply bottom-up.
  @UseGuards(RecentAuthGuard)
  @RequireProjectPermission('privacy')
  @UseGuards(JwtAuthGuard)
  @Post('projects/:projectId/tracking-objections/lift')
  @HttpCode(HttpStatus.OK)
  async liftPersonObjection(
    @Param('projectId') projectId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PersonObjectionTargetDto,
    @Req() req: Request,
  ) {
    refuseViewAs(user, VIEW_AS_NOT_AVAILABLE);
    return this.personObjections.lift(projectId, dto.externalUserId, requesterOf(user.userId, req));
  }

  // Dashboard lookups. Both need `people.read` like every other project route:
  // the project comes from the path and must have the signed-in user as a member,
  // and the query is bound to it. They once took an optional or no project at all,
  // which let any signed-in account read another tenant's people.
  @RequireProjectPermission('people.read')
  @UseGuards(JwtAuthGuard)
  @Get('projects/:projectId/devices')
  async getDevices(
    @Param('projectId') projectId: string,
    @Query('userId') externalUserId: string,
  ) {
    if (!externalUserId) throw new BadRequestException('userId is required');
    return this.identityService.getDevicesByUser(externalUserId, projectId);
  }

  @RequireProjectPermission('people.read')
  @UseGuards(JwtAuthGuard)
  @Get('projects/:projectId/device/:fingerprint')
  async findByFingerprint(
    @Param('projectId') projectId: string,
    @Param('fingerprint') fingerprint: string,
  ) {
    const identity = await this.identityService.findByFingerprintAndProject(fingerprint, projectId);
    if (!identity) throw new NotFoundException('Device not found');
    return identity;
  }
}
