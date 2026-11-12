import { IsString, IsOptional, IsIn, IsUUID, MaxLength} from 'class-validator';
import { ImpressionEventType } from '../entities/in-app-message-impression.entity';


export class MessageActionDto {
  @IsUUID()
  messageId: string;

  @IsString()
  projectId: string;

  @IsString()
  @MaxLength(255)
  deviceFingerprint: string;

  /**
   * 512, matching `in_app_message_impressions.distinct_id` — and **the same
   * logical identifier has two different ceilings in this schema.** It is
   * varchar(512) here and in `pending_in_app_messages`, but varchar(255) in
   * `device_identities`, `user_events`, `click_events`, `conversion_events`,
   * `touchpoints` and `attribution_results`.
   *
   * The failure shape, if you ever meet it: a distinct id between 256 and 512
   * characters stores successfully through this endpoint and then fails on
   * every other path that writes the same identifier. Every DTO's limit is
   * matched to its own target column, so nothing returns a 500 today, and no
   * SDK generates one over 255 (they are UUIDs) — so this is recorded rather
   * than migrated. Reconciling seven columns across seven tables deserves its
   * own task.
   */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  distinctId?: string;

  @IsIn(['delivered', 'impression', 'click', 'dismiss', 'cta_click', 'auto_dismiss', 'expired'])
  eventType: ImpressionEventType;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  buttonId?: string;
}
