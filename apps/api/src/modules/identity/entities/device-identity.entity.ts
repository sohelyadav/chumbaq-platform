import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';

@Entity('device_identities')
@Index(['projectId', 'deviceFingerprint'], { unique: true })
@Index(['projectId', 'distinctId'])
// Email recipient selection reads `project_id = ? AND email IS NOT NULL` and
// deduplicates on (project_id, email). Partial because most identities never
// carry an address.
@Index(['projectId', 'email'], { where: '"email" IS NOT NULL' })
// Same shape for SMS, on the normalised number.
@Index(['projectId', 'phoneE164'], { where: '"phone_e164" IS NOT NULL' })
export class DeviceIdentityEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'varchar', length: 255, nullable: true, name: 'external_user_id' })
  externalUserId: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'distinct_id' })
  distinctId: string;

  @Index()
  @Column({ type: 'varchar', length: 255, name: 'device_fingerprint' })
  deviceFingerprint: string;

  @Column({ type: 'varchar', length: 50 })
  platform: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'user_agent' })
  userAgent: string;

  @Column({ type: 'varchar', length: 45, nullable: true, name: 'ip_address' })
  ipAddress: string;

  @Column({ type: 'jsonb', nullable: true })
  traits: Record<string, unknown>;

  // --- Profile fields ---
  @Column({ type: 'varchar', length: 100, nullable: true, name: 'first_name' })
  firstName: string;

  @Column({ type: 'varchar', length: 100, nullable: true, name: 'last_name' })
  lastName: string;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phone: string;

  /**
   * Where this person receives SMS: `phone` (or the `$phone` / `phone`
   * trait) in E.164 form, or null when the number has no country code.
   *
   * Kept apart from `phone`, which stays as the app reported it for display,
   * because recipient selection deduplicates and checks suppressions on it
   * in SQL, and those need one canonical spelling of each number.
   */
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'phone_e164' })
  phoneE164: string | null;

  /**
   * Where this person receives email, normalised (trimmed, lowercased).
   *
   * A real column rather than a read of `traits.$email`, because recipient
   * selection deduplicates on it and checks it against the suppression list
   * in SQL — neither is something a jsonb path can be indexed for cheaply.
   * Filled from `IdentifyDto.email`, or from the `$email` / `email` trait
   * that apps were already sending.
   */
  @Column({ type: 'varchar', length: 320, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 2048, nullable: true })
  avatar: string;

  /**
   * BCP-47, which needs more than the 10 characters this used to be:
   * `en-US-POSIX` is a real Apple locale identifier at 11, and a
   * language-script-region tag with a variant is longer still. At 10 an
   * honest device locale reached the insert and returned a raw 500
   * (`value too long for type character varying(10)`). 35 is the practical
   * BCP-47 ceiling and what `Accept-Language` parsers allow.
   */
  @Column({ type: 'varchar', length: 35, nullable: true })
  locale: string;

  @Column({ type: 'varchar', length: 35, nullable: true })
  language: string;

  // --- Device properties ---
  @Column({ type: 'varchar', length: 50, nullable: true })
  os: string;

  @Column({ type: 'varchar', length: 30, nullable: true, name: 'os_version' })
  osVersion: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  browser: string;

  @Column({ type: 'varchar', length: 30, nullable: true, name: 'browser_version' })
  browserVersion: string;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'app_version' })
  appVersion: string;

  @Column({ type: 'varchar', length: 30, nullable: true, name: 'app_build' })
  appBuild: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  manufacturer: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  brand: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  model: string;

  @Column({ type: 'int', nullable: true, name: 'screen_height' })
  screenHeight: number;

  @Column({ type: 'int', nullable: true, name: 'screen_width' })
  screenWidth: number;

  @Column({ type: 'varchar', length: 100, nullable: true })
  carrier: string;

  // --- Geo properties ---
  @Column({ type: 'varchar', length: 100, nullable: true })
  country: string;

  @Column({ type: 'varchar', length: 10, nullable: true, name: 'country_code' })
  countryCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  region: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  city: string;

  @Column({ type: 'varchar', length: 50, nullable: true })
  timezone: string;

  @Column({ type: 'float', nullable: true })
  latitude: number;

  @Column({ type: 'float', nullable: true })
  longitude: number;

  // --- Initial attribution (set once on first seen) ---
  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'initial_referrer' })
  initialReferrer: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_referring_domain' })
  initialReferringDomain: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_utm_source' })
  initialUtmSource: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_utm_medium' })
  initialUtmMedium: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_utm_campaign' })
  initialUtmCampaign: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_utm_content' })
  initialUtmContent: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'initial_utm_term' })
  initialUtmTerm: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'install_source' })
  installSource: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'install_campaign' })
  installCampaign: string;

  // --- Latest attribution ---
  @Column({ type: 'varchar', length: 2048, nullable: true, name: 'latest_referrer' })
  latestReferrer: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'latest_utm_source' })
  latestUtmSource: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'latest_utm_medium' })
  latestUtmMedium: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'latest_utm_campaign' })
  latestUtmCampaign: string;

  // --- Engagement metrics ---
  @Column({ type: 'int', default: 0, name: 'total_sessions' })
  totalSessions: number;

  @Column({ type: 'decimal', precision: 12, scale: 2, default: 0, name: 'total_revenue' })
  totalRevenue: number;

  @Column({ type: 'timestamp', nullable: true, name: 'last_event_at' })
  lastEventAt: Date;

  @Column({ type: 'varchar', length: 3, nullable: true })
  currency: string;

  // --- Consent / compliance ---
  @Column({ type: 'boolean', nullable: true, name: 'email_opt_in' })
  emailOptIn: boolean;

  @Column({ type: 'boolean', nullable: true, name: 'sms_opt_in' })
  smsOptIn: boolean;

  /**
   * WhatsApp marketing consent, separate from SMS: Meta's policy requires
   * opt-in to WhatsApp specifically, and someone who agreed to texts has not
   * agreed to WhatsApp messages.
   */
  @Column({ type: 'boolean', nullable: true, name: 'whatsapp_opt_in' })
  whatsappOptIn: boolean | null;

  @Column({ type: 'boolean', nullable: true, name: 'push_opt_in' })
  pushOptIn: boolean;

  @Column({ type: 'boolean', nullable: true, name: 'gdpr_consent' })
  gdprConsent: boolean;

  @Column({ type: 'boolean', default: false, name: 'do_not_track' })
  doNotTrack: boolean;

  /**
   * Who last set `do_not_track`: `sdk` (an unverified claim from the app) or
   * `dashboard` (a signed-in team member). The SDK cannot clear a flag the
   * dashboard set. Null when it was never set.
   */
  @Column({ type: 'varchar', length: 10, nullable: true, name: 'do_not_track_source' })
  doNotTrackSource: 'sdk' | 'dashboard' | null;

  @Column({ type: 'timestamp', nullable: true, name: 'consent_updated_at' })
  consentUpdatedAt: Date;

  // --- Timestamps ---
  @CreateDateColumn({ name: 'first_seen_at' })
  firstSeenAt: Date;

  @UpdateDateColumn({ name: 'last_seen_at' })
  lastSeenAt: Date;
}
