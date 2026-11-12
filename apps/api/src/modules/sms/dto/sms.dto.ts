import {
  IsArray,
  IsBoolean,
  IsDateString,
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
import { SMS_PROVIDERS, SmsProviderName } from '../../push-notifications/message-channel';
import { MAX_CONTROL_PERCENTAGE } from '../../push-notifications/variant-assignment';
import { PushRecurrence } from '../../push-notifications/recurrence';
import {
  SUPPRESSION_REASONS,
  SuppressionReason,
} from '../../push-notifications/entities/channel-suppression.entity';
import { MAX_SMS_LENGTH } from '../sms-rendering';

/**
 * An E.164 number, a Twilio Messaging Service SID, or an alphanumeric
 * sender ID (1–11 letters, digits and spaces, at least one letter).
 */
export const SMS_SENDER_PATTERN =
  /^(\+[1-9]\d{7,14}|MG[0-9a-fA-F]{32}|(?=[A-Za-z0-9 ]*[A-Za-z])[A-Za-z0-9 ]{1,11})$/;

export class UpdateSmsSettingsDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @Matches(SMS_SENDER_PATTERN, {
    message:
      'The sender must be a number in international form (+14155550123), a Messaging Service SID (MG...), or a sender ID of up to 11 letters and digits.',
  })
  sender: string;

  @IsBoolean()
  @IsOptional()
  requireOptIn?: boolean;

  /** Empty string for none. */
  @IsString()
  @MaxLength(80)
  @IsOptional()
  optOutText?: string;
}

export class ConnectSmsProviderDto {
  @IsUUID()
  projectId: string;

  @IsIn(SMS_PROVIDERS)
  provider: SmsProviderName;

  @IsString()
  @MaxLength(10_000)
  credentials: string;
}

export class SmsVariantDto {
  @IsString()
  @MaxLength(16)
  key: string;

  /** A label for the arm in reports. Named `title` because arms share the push shape. */
  @IsString()
  @MaxLength(255)
  title: string;

  /** The arm's text. */
  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SMS_LENGTH)
  body: string;

  @IsNumber()
  @Min(0)
  @Max(100)
  weight: number;
}

export class SendSmsCampaignDto {
  @IsUUID()
  projectId: string;

  /** Shown in campaign lists; defaults to the start of the text. */
  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SMS_LENGTH)
  body: string;

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
  @Type(() => SmsVariantDto)
  @IsOptional()
  variants?: SmsVariantDto[];

  @IsInt()
  @Min(0)
  @Max(MAX_CONTROL_PERCENTAGE)
  @IsOptional()
  controlPercentage?: number;

  @IsObject()
  @IsOptional()
  recurrence?: PushRecurrence;
}

export class SmsAudiencePreviewDto {
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

export class TestSendSmsDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MinLength(1)
  @MaxLength(MAX_SMS_LENGTH)
  body: string;

  @IsString()
  @MaxLength(32)
  to: string;
}

export class AddSmsSuppressionDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(32)
  address: string;

  @IsIn(SUPPRESSION_REASONS)
  @IsOptional()
  reason?: SuppressionReason;
}
