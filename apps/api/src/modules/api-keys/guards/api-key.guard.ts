import { getClientIp } from '../../../common/client-ip';
import { TripwiresService } from '../../security-alerts/tripwires.service';
import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiKeysService } from '../api-keys.service';
import { isServerOnlyKey } from '../api-key-permissions';

/** Exact text, so a developer searching for it lands on the explanation. */
export const SERVER_ONLY_KEY_MESSAGE =
  'This is a server-only privacy key and cannot be used by an app or SDK. Use an ordinary API key in your app.';

/**
 * The guard on every SDK route. Keys here ship inside apps, so this guard
 * grants nothing beyond "a live key of this project" and refuses server-only
 * keys outright: see `api-key-permissions.ts`.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly tripwires: TripwiresService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const apiKey = request.headers['x-api-key'];

    if (!apiKey) {
      throw new UnauthorizedException('API key is required');
    }

    const keyEntity = await this.apiKeysService.validateKey(apiKey);
    if (!keyEntity) {
      // Not awaited: a trap key gets this same answer, as quickly.
      this.tripwires.checkApiKeyLater(apiKey, { ip: getClientIp(request) || null, route: `${request.method} ${request.path}` });
      throw new UnauthorizedException('Invalid or expired API key');
    }

    if (isServerOnlyKey(keyEntity.permissions)) {
      throw new ForbiddenException(SERVER_ONLY_KEY_MESSAGE);
    }

    request.apiKey = keyEntity;
    request.projectId = keyEntity.projectId;

    return true;
  }
}
