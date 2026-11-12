import { getClientIp } from '../../../common/client-ip';
import { TripwiresService } from '../../security-alerts/tripwires.service';
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiKeyPermission } from '@chumbaq/shared';
import { ApiKeysService } from '../api-keys.service';

export const API_KEY_PERMISSION_METADATA = 'chumbaq:api-key-permission';

/** The permission a `ServerApiKeyGuard` route needs. Required: the guard refuses without it. */
export const RequireApiKeyPermission = (permission: ApiKeyPermission) =>
  SetMetadata(API_KEY_PERMISSION_METADATA, permission);

/**
 * For server-to-server routes that act on people (erase, export). Validates
 * the key itself rather than after `ApiKeyGuard`, which refuses server-only
 * keys, and then requires the permission named by `@RequireApiKeyPermission`
 * on the handler or controller. Fails closed: a route that forgot the
 * decorator is refused, not opened.
 */
@Injectable()
export class ServerApiKeyGuard implements CanActivate {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly reflector: Reflector,
    private readonly tripwires: TripwiresService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<ApiKeyPermission | undefined>(
      API_KEY_PERMISSION_METADATA,
      [context.getHandler(), context.getClass()],
    );
    if (!required) {
      throw new ForbiddenException('This route has no permission configured');
    }

    const request = context.switchToHttp().getRequest();
    const rawKey = request.headers['x-api-key'];
    if (!rawKey || typeof rawKey !== 'string') {
      throw new UnauthorizedException('API key is required');
    }

    const key = await this.apiKeysService.validateKey(rawKey);
    if (!key) {
      this.tripwires.checkApiKeyLater(rawKey, { ip: getClientIp(request) || null, route: `${request.method} ${request.path}` });
      throw new UnauthorizedException('Invalid or expired API key');
    }

    if (!Array.isArray(key.permissions) || !key.permissions.includes(required)) {
      throw new ForbiddenException(
        `This API key does not have the "${required}" permission. Create a server-only key with it in the dashboard.`,
      );
    }

    request.apiKey = key;
    request.projectId = key.projectId;
    return true;
  }
}
