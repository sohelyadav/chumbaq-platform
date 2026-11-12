import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { CLIENT_HEADER } from '../auth-cookies.service';

/**
 * On every route that sets the refresh cookie. SameSite stops a cookie being sent, not
 * being set, so without this a form on another site could post an attacker's password
 * here and leave the victim's browser signed in to the attacker's account, where
 * whatever they enter next lands. A cross-site form cannot set a custom header.
 */
@Injectable()
export class ClientHeaderGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (!request.headers[CLIENT_HEADER]) {
      throw new ForbiddenException('Missing client header');
    }
    return true;
  }
}
