import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  AddressAudience,
  AddressAudienceScope,
} from '../push-notifications/services/address-audience';

/** Kept under its own name: every email caller already speaks it. */
export type EmailAudienceScope = AddressAudienceScope;

/** Who an email campaign may reach: one identity per address, by `email`. */
@Injectable()
export class EmailAudienceService extends AddressAudience {
  protected readonly columns = {
    channel: 'email',
    address: 'email',
    consent: 'email_opt_in',
  } as const;

  constructor(
    @InjectRepository(DeviceIdentityEntity)
    identityRepository: Repository<DeviceIdentityEntity>,
  ) {
    super(identityRepository);
  }
}
