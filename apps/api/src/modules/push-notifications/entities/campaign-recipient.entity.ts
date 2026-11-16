import { Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';
import { PushNotificationLogEntity } from './push-notification-log.entity';

/**
 * Who a campaign is for, one row per device, when it is not the whole project.
 *
 * A table rather than a list on the campaign row, so an audience has no size limit:
 * recipients are written by one INSERT ... SELECT from the segment or list, and every
 * reader joins on them. `role` is `target` for those a campaign sends to, and
 * `control` for an experiment parent's held-back slice, which nothing is sent to and
 * the report measures against. Rows go with their campaign and with their device
 * (erasure deletes the device row).
 */
@Entity('campaign_recipients')
@Index('IDX_campaign_recipients_device', ['deviceIdentityId'])
export class CampaignRecipientEntity {
  @PrimaryColumn({ type: 'uuid', name: 'campaign_id' })
  campaignId: string;

  @PrimaryColumn({ type: 'varchar', length: 8, name: 'role' })
  role: 'target' | 'control';

  @PrimaryColumn({ type: 'uuid', name: 'device_identity_id' })
  deviceIdentityId: string;

  @ManyToOne(() => PushNotificationLogEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'campaign_id' })
  campaign?: PushNotificationLogEntity;

  @ManyToOne(() => DeviceIdentityEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_identity_id' })
  deviceIdentity?: DeviceIdentityEntity;
}
