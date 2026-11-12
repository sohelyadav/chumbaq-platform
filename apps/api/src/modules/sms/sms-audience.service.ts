import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { AddressAudience } from '../push-notifications/services/address-audience';

/**
 * Who an SMS campaign may reach: one identity per number, by `phone_e164`,
 * so a person with an app on two devices gets one text, not two.
 */
@Injectable()
export class SmsAudienceService extends AddressAudience {
  protected readonly columns = {
    channel: 'sms',
    address: 'phone_e164',
    consent: 'sms_opt_in',
  } as const;

  constructor(
    @InjectRepository(DeviceIdentityEntity)
    identityRepository: Repository<DeviceIdentityEntity>,
  ) {
    super(identityRepository);
  }
}
