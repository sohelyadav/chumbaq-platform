import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';

/**
 * What a consent event is about. The four messaging channels, `gdpr` for the
 * general processing consent flag, and `tracking` for behavioural analytics
 * (the inverse of `do_not_track`: `granted = false` means do-not-track was
 * turned on).
 */
export const CONSENT_CHANNELS = ['email', 'sms', 'whatsapp', 'push', 'gdpr', 'tracking'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/**
 * Who or what changed it.
 *
 * - `sdk`: `POST /api/identity/identify` with a consent field. That endpoint is
 *   authenticated by the project API key, which ships inside the app, so a call
 *   from the tenant's own server cannot be told apart from one from the SDK and
 *   is recorded the same way.
 * - `dashboard`: a team member, through the person's consent or a channel's
 *   suppression list.
 * - `unsubscribe_link`: the signed link in an email (GET confirms, POST acts).
 * - `provider_unsubscribe`: the email provider reported an unsubscribe.
 * - `complaint`: the recipient marked an email as spam.
 * - `stop_reply` / `start_reply`: a STOP or START reply to a text or WhatsApp
 *   message (or Twilio's 21610, which means the carrier holds a STOP).
 * - `provider_unsubscribe_unsigned` / `complaint_unsigned`: the same from an
 *   email webhook nobody signed (Brevo has no signature scheme). Honoured,
 *   recorded as unconfirmed.
 * - `stop_reply_unsigned`: a STOP from a webhook nobody signed (Gupshup, or
 *   Meta/Interakt with no stored secret). Honoured, since it can only add
 *   protection, but anyone holding the URL could have sent it, so it is not
 *   recorded as a verified statement. An unsigned START is never honoured.
 */
export const CONSENT_SOURCES = [
  'sdk',
  'dashboard',
  'unsubscribe_link',
  'provider_unsubscribe',
  'provider_unsubscribe_unsigned',
  'complaint',
  'complaint_unsigned',
  'stop_reply',
  'stop_reply_unsigned',
  'start_reply',
] as const;
export type ConsentSource = (typeof CONSENT_SOURCES)[number];

/**
 * One change to one person's consent. Append-only: `ConsentEventsService` is
 * the only writer and never updates or deletes a row.
 *
 * Kept so the fiduciary can show when consent was given and when it was
 * withdrawn (DPDP Act s.6(10)); `device_identities.consent_updated_at` only
 * says when something last changed. Rows go with the identity they describe
 * (ON DELETE CASCADE), so erasing a person erases their history with them.
 */
@Entity('consent_events')
@Index(['projectId', 'deviceIdentityId', 'occurredAt'])
export class ConsentEventEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Column({ type: 'uuid', name: 'device_identity_id' })
  deviceIdentityId: string;

  @ManyToOne(() => DeviceIdentityEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_identity_id' })
  deviceIdentity: DeviceIdentityEntity;

  @Column({ type: 'varchar', length: 20 })
  channel: ConsentChannel;

  @Column({ type: 'boolean' })
  granted: boolean;

  @Column({ type: 'varchar', length: 32 })
  source: ConsentSource;

  @CreateDateColumn({ type: 'timestamptz', name: 'occurred_at' })
  occurredAt: Date;
}
