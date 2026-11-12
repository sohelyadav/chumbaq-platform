import { CanActivate, ExecutionContext, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, timingSafeEqual } from 'crypto';
import type { Request } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

/**
 * For the localhost route server scripts call. With `SECURITY_ALERT_TOKEN` unset the
 * route answers 404, as if it did not exist, as it does for anything proxied (nginx adds
 * X-Forwarded-For); otherwise the `X-Security-Alert-Token`
 * header must match, compared in constant time (digests, so lengths never differ).
 */
@Injectable()
export class InternalAlertTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const expected = this.config.get<string>('SECURITY_ALERT_TOKEN')?.trim();
    if (!expected) throw new NotFoundException();
    const request = context.switchToHttp().getRequest<Request>();
    // Server scripts call 127.0.0.1 directly. nginx always adds these, so a request that
    // carries one came from outside, whatever nginx's own rules for /api/internal/ say.
    if (request.header('x-forwarded-for') !== undefined || request.header('x-real-ip') !== undefined) {
      throw new NotFoundException();
    }
    const presented = request.header('x-security-alert-token') ?? '';
    if (!timingSafeEqual(digest(presented), digest(expected))) {
      throw new UnauthorizedException('Invalid alarm token');
    }
    return true;
  }
}
