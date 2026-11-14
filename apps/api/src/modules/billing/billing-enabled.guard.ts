import { CanActivate, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingConfig } from '../../config/billing.config';

/**
 * Every billing route answers Nest's plain 404 while billing is off, the same as a
 * route that does not exist, so a self-hosted install shows no trace of billing.
 */
@Injectable()
export class BillingEnabledGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(): boolean {
    if (this.config.get<BillingConfig>('billing')?.enabled !== true) throw new NotFoundException();
    return true;
  }
}
