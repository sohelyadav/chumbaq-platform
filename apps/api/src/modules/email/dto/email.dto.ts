import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEmail,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { EMAIL_PROVIDERS, EmailProviderName } from '../../push-notifications/message-channel';
import { MAX_CONTROL_PERCENTAGE } from '../../push-notifications/variant-assignment';
import { PushRecurrence } from '../../push-notifications/recurrence';
import { SUPPRESSION_REASONS, SuppressionReason } from '../../push-notifications/entities/channel-suppression.entity';

/** Generous, but bounded: Gmail clips messages over ~102 KB anyway. */
export const MAX_EMAIL_HTML = 500_000;

export class UpdateEmailSettingsDto {
  @IsUUID()
  projectId: string;

  @IsEmail()
  @MaxLength(320)
  fromEmail: string;

  @IsString()
  @MaxLength(100)
  @IsOptional()
  fromName?: string;

  @IsEmail()
  @MaxLength(320)
  @IsOptional()
  replyTo?: string;

  @IsString()
  @MinLength(5)
  @MaxLength(500)
  postalAddress: string;

  @IsBoolean()
  @IsOptional()
  requireOptIn?: boolean;
}

/**
 * Credentials for an email provider. Opaque JSON here, validated by the
 * provider that owns the shape — the same pattern as push channels.
 */
export class ConnectEmailProviderDto {
  @IsUUID()
  projectId: string;

  @IsIn(EMAIL_PROVIDERS)
  provider: EmailProviderName;

  @IsString()
  @MaxLength(10_000)
  credentials: string;
}

export class EmailVariantDto {
  @IsString()
  @MaxLength(16)
  key: string;

  /** The arm's subject. Named `title` because arms share the push shape. */
  @IsString()
  @MaxLength(255)
  title: string;

  /** Plain-text part for this arm. */
  @IsString()
  @MaxLength(MAX_EMAIL_HTML)
  @IsOptional()
  body?: string;

  @IsString()
  @MaxLength(MAX_EMAIL_HTML)
  @IsOptional()
  html?: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  preheader?: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  weight: number;
}

class EmailContentFields {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  subject: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_EMAIL_HTML)
  html: string;

  @IsString()
  @MaxLength(MAX_EMAIL_HTML)
  @IsOptional()
  text?: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  preheader?: string;
}

export class SendEmailCampaignDto extends EmailContentFields {
  @IsUUID()
  projectId: string;

  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  deviceIdentityIds?: string[];

  @IsUUID()
  @IsOptional()
  segmentId?: string;

  @IsDateString()
  @IsOptional()
  scheduledAt?: string;

  @IsBoolean()
  @IsOptional()
  deliverInRecipientTimezone?: boolean;

  @IsString()
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, {
    message: 'localSendTime must be HH:MM in 24-hour form',
  })
  @IsOptional()
  localSendTime?: string;

  @IsBoolean()
  @IsOptional()
  sendTimeOptimised?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EmailVariantDto)
  @IsOptional()
  variants?: EmailVariantDto[];

  @IsInt()
  @Min(0)
  @Max(MAX_CONTROL_PERCENTAGE)
  @IsOptional()
  controlPercentage?: number;

  @IsObject()
  @IsOptional()
  recurrence?: PushRecurrence;
}

export class EmailAudiencePreviewDto {
  @IsUUID()
  projectId: string;

  @IsUUID()
  @IsOptional()
  segmentId?: string;

  @IsArray()
  @IsUUID('all', { each: true })
  @IsOptional()
  deviceIdentityIds?: string[];
}

export class TestSendEmailDto extends EmailContentFields {
  @IsUUID()
  projectId: string;

  @IsEmail()
  to: string;
}

export class AddSuppressionDto {
  @IsUUID()
  projectId: string;

  @IsEmail()
  address: string;

  @IsIn(SUPPRESSION_REASONS)
  @IsOptional()
  reason?: SuppressionReason;
}
