import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import { AddressAudience } from '../push-notifications/services/address-audience';

/**
 * Who a WhatsApp campaign may reach: one identity per number, by
 * `phone_e164`, under WhatsApp's own consent and WhatsApp's own
 * suppressions — opting out of texts says nothing about WhatsApp, and the
 * reverse.
 */
@Injectable()
export class WhatsAppAudienceService extends AddressAudience {
  protected readonly columns = {
    channel: 'whatsapp',
    address: 'phone_e164',
    consent: 'whatsapp_opt_in',
  } as const;

  constructor(
    @InjectRepository(DeviceIdentityEntity)
    identityRepository: Repository<DeviceIdentityEntity>,
  ) {
    super(identityRepository);
  }
}
