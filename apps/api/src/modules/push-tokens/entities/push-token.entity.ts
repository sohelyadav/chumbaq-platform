import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { ProjectEntity } from '../../projects/entities/project.entity';
import { DeviceIdentityEntity } from '../../identity/entities/device-identity.entity';

export type PushPlatform = 'ios' | 'android' | 'web';
/**
 * Every channel a token can be delivered through.
 *
 * The OEM entries exist because Xiaomi, Oppo, Vivo, Honor and Huawei throttle
 * background FCM delivery aggressively, and Huawei devices without Google Play
 * Services have no FCM at all. Each vendor's own push service is whitelisted
 * at the OS level, so on those devices the vendor channel is the one that
 * arrives.
 */
export const PUSH_PROVIDERS = [
  'fcm',
  'apns',
  'mi_push',
  'huawei',
  'oppo',
  'vivo',
  'honor',
] as const;

export type PushProvider = (typeof PUSH_PROVIDERS)[number];

/**
 * Preference order when one device holds tokens on several channels. Lower
 * wins.
 *
 * A vendor channel beats FCM on the devices that have one, which is the whole
 * point: it is the delivery that actually arrives there. FCM and APNs share a
 * rank because they never compete — a device is iOS or it is Android — and the
 * id tiebreak in the selection predicate settles the case that cannot happen
 * rather than leaving it undefined.
 */
export const PROVIDER_RANK: Record<PushProvider, number> = {
  mi_push: 10,
  huawei: 10,
  oppo: 10,
  vivo: 10,
  honor: 10,
  fcm: 50,
  apns: 50,
};

/** `provider_rank(t.provider)` as SQL, for the token-selection predicate. */
export function providerRankSql(column: string): string {
  const cases = Object.entries(PROVIDER_RANK)
    .map(([provider, rank]) => `WHEN '${provider}' THEN ${rank}`)
    .join(' ');
  // The ELSE is unreachable for a validated provider, but an unranked value
  // silently sorting first would hand delivery to a channel nobody chose.
  return `CASE ${column} ${cases} ELSE 100 END`;
}

/**
 * Why a token stopped being reachable.
 *
 * The distinction is the whole point of recording it. `app_requested` is a
 * logout or an explicit opt-out — the app is still installed. Only
 * `provider_rejected` carries any uninstall signal, and even then it is a
 * signal rather than a fact: FCM returns UNREGISTERED for an uninstall, a
 * cleared app storage, and a rotated token alike, and does not say which.
 */
export type TokenDeactivationReason = 'provider_rejected' | 'app_requested';

@Entity('push_tokens')
@Index(['projectId', 'token'], { unique: true })
// The campaign worker walks tokens by keyset —
// `WHERE project_id = ? AND is_active AND id > ? ORDER BY id LIMIT 500` (and the
// device-targeted equivalent). Against a single-column project_id index the
// planner has to sort the whole matching set once per page, so cost grows with
// the campaign rather than with the page. Leading the index with the equality
// column and following it with the ordering column lets each page be an index
// range scan that stops at the limit.
@Index(['projectId', 'id'])
@Index(['deviceIdentityId', 'id'])
// Reachability reporting reads `project_id = ? AND deactivated_at >= ?`.
// Partial because the overwhelming majority of rows are live and hold NULL
// here — indexing those would be most of the table for no benefit, while the
// rows this reads are the small minority.
@Index(['projectId', 'deactivatedAt'], { where: '"deactivated_at" IS NOT NULL' })
export class PushTokenEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index()
  @Column({ type: 'uuid', name: 'project_id' })
  projectId: string;

  @ManyToOne(() => ProjectEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: ProjectEntity;

  @Index()
  @Column({ type: 'uuid', name: 'device_identity_id' })
  deviceIdentityId: string;

  @ManyToOne(() => DeviceIdentityEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_identity_id' })
  deviceIdentity: DeviceIdentityEntity;

  @Column({ type: 'text' })
  token: string;

  @Column({ type: 'varchar', length: 10 })
  platform: PushPlatform;

  @Column({ type: 'varchar', length: 10, default: 'fcm' })
  provider: PushProvider;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive: boolean;

  @Column({ type: 'timestamp', nullable: true, name: 'last_used_at' })
  lastUsedAt: Date;

  /**
   * When `isActive` last went false. Null while the token is live.
   *
   * Separate from `updatedAt`, which moves for any write — a `lastUsedAt`
   * refresh included — and so cannot date the event.
   */
  @Column({ type: 'timestamptz', nullable: true, name: 'deactivated_at' })
  deactivatedAt: Date | null;

  @Column({
    type: 'varchar',
    length: 20,
    nullable: true,
    name: 'deactivation_reason',
  })
  deactivationReason: TokenDeactivationReason | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
