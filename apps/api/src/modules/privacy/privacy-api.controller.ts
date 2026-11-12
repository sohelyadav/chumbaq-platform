import { VolumeWatchService, countPersonExportRows } from '../security-alerts/volume-watch.service';
import { Body, Controller, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Request } from 'express';
import type { PersonErasureResult, PersonExport } from '@chumbaq/shared';
import {
  RequireApiKeyPermission,
  ServerApiKeyGuard,
} from '../api-keys/guards/server-api-key.guard';
import type { ApiKeyEntity } from '../api-keys/entities/api-key.entity';
import { PersonErasureService } from './person-erasure.service';
import { PersonExportService } from './person-export.service';
import { PrivacyRequestDto, subjectFromRequest } from './dto/privacy-request.dto';
import { activityContext } from '../project-activity/activity-context';
import type { PrivacyActor } from './privacy-actor';

/** The calling key, set by `ServerApiKeyGuard`. */
type KeyedRequest = Request & { apiKey: ApiKeyEntity };

/** The key as the request's actor: its id for the privacy log, its name for the activity log. */
function keyActor(request: KeyedRequest): PrivacyActor {
  return { type: 'api_key', id: request.apiKey.id, name: request.apiKey.name };
}

/**
 * Server-to-server privacy API, for a customer's backend handling a person's
 * erasure or access request. Needs an API key with the `privacy` permission,
 * which is server-only (see `api-key-permissions.ts`): the ordinary keys that
 * ship inside apps are refused. The project is the key's own; nothing in the
 * request can name another.
 *
 * No SDK calls these. An app's "delete my account" should call the customer's
 * backend, which calls this with a key kept on the server.
 *
 * Both are written to the project activity log as `person.erased` and
 * `person.exported`, with the key (`API key "<name>"`) as the actor.
 */
@Controller('privacy')
@UseGuards(ServerApiKeyGuard)
@RequireApiKeyPermission('privacy')
export class PrivacyApiController {
  constructor(
    private readonly erasure: PersonErasureService,
    private readonly exporter: PersonExportService,
    private readonly volume: VolumeWatchService,
  ) {}

  @Post('erasures')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  erase(
    @Body() dto: PrivacyRequestDto,
    @Req() request: KeyedRequest,
  ): Promise<PersonErasureResult> {
    const subject = subjectFromRequest(dto);
    return this.erasure.erase(request.apiKey.projectId, subject, keyActor(request), activityContext(request));
  }

  @Post('exports')
  @HttpCode(200)
  @Throttle({ default: { ttl: 60_000, limit: 30 } })
  async export(
    @Body() dto: PrivacyRequestDto,
    @Req() request: KeyedRequest,
  ): Promise<PersonExport> {
    const subject = subjectFromRequest(dto);
    const exported = await this.exporter.export(request.apiKey.projectId, subject, keyActor(request), activityContext(request));
    // A leaked privacy key looping over ids is the likeliest bulk leak: counted per key.
    this.volume.exported(`api_key:${request.apiKey.id}`, request.apiKey.projectId, countPersonExportRows(exported), 'privacy API export');
    return exported;
  }
}
