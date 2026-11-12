import {
  ArrayMaxSize,
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
import {
  WHATSAPP_PROVIDERS,
  WhatsAppProviderName,
} from '../../push-notifications/message-channel';
import { MAX_CONTROL_PERCENTAGE } from '../../push-notifications/variant-assignment';
import { PushRecurrence } from '../../push-notifications/recurrence';
import {
  SUPPRESSION_REASONS,
  SuppressionReason,
} from '../../push-notifications/entities/channel-suppression.entity';

export class UpdateWhatsAppSettingsDto {
  @IsUUID()
  projectId: string;

  @IsBoolean()
  @IsOptional()
  requireOptIn?: boolean;
}

export class ConnectWhatsAppProviderDto {
  @IsUUID()
  projectId: string;

  @IsIn(WHATSAPP_PROVIDERS)
  provider: WhatsAppProviderName;

  @IsString()
  @MaxLength(10_000)
  credentials: string;
}

export class WhatsAppTemplateRefDto {
  /** Name (Meta, Interakt), template id (Gupshup) or Content SID (Twilio). */
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  id: string;

  @IsString()
  @MinLength(1)
  @MaxLength(512)
  name: string;

  @IsString()
  @Matches(/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/, { message: 'language must be a code such as en or en_US' })
  language: string;

  @IsString()
  @MaxLength(32)
  @IsOptional()
  category?: string | null;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsOptional()
  paramNames?: string[] | null;
}

export class WhatsAppContentDto {
  @ValidateNested()
  @Type(() => WhatsAppTemplateRefDto)
  template: WhatsAppTemplateRefDto;

  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(1024, { each: true })
  bodyParams: string[];

  @IsString()
  @MaxLength(1024)
  @IsOptional()
  headerText?: string | null;

  @IsString()
  @Matches(/^https:\/\/\S+$/, { message: 'headerMediaUrl must be a public https URL' })
  @MaxLength(2048)
  @IsOptional()
  headerMediaUrl?: string | null;

  @IsIn(['image', 'video', 'document'])
  @IsOptional()
  headerMediaType?: 'image' | 'video' | 'document' | null;

  @IsArray()
  @ArrayMaxSize(2)
  @IsString({ each: true })
  @MaxLength(512, { each: true })
  @IsOptional()
  buttonParams?: string[];

  @IsString()
  @MaxLength(4096)
  @IsOptional()
  previewText?: string | null;
}

export class WhatsAppVariantDto {
  @IsString()
  @MaxLength(16)
  key: string;

  /** A label for the arm in reports. */
  @IsString()
  @MaxLength(255)
  title: string;

  @ValidateNested()
  @Type(() => WhatsAppContentDto)
  content: WhatsAppContentDto;

  @IsNumber()
  @Min(0)
  @Max(100)
  weight: number;
}

export class SendWhatsAppCampaignDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(255)
  @IsOptional()
  name?: string;

  @ValidateNested()
  @Type(() => WhatsAppContentDto)
  content: WhatsAppContentDto;

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
  @Matches(/^([01]\d|2[0-3]):([0-5]\d)$/, { message: 'localSendTime must be HH:MM in 24-hour form' })
  @IsOptional()
  localSendTime?: string;

  @IsBoolean()
  @IsOptional()
  sendTimeOptimised?: boolean;

  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => WhatsAppVariantDto)
  @IsOptional()
  variants?: WhatsAppVariantDto[];

  @IsInt()
  @Min(0)
  @Max(MAX_CONTROL_PERCENTAGE)
  @IsOptional()
  controlPercentage?: number;

  @IsObject()
  @IsOptional()
  recurrence?: PushRecurrence;
}

export class WhatsAppAudiencePreviewDto {
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

export class TestSendWhatsAppDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(32)
  to: string;

  @ValidateNested()
  @Type(() => WhatsAppContentDto)
  content: WhatsAppContentDto;
}

export class AddWhatsAppSuppressionDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(32)
  address: string;

  @IsIn(SUPPRESSION_REASONS)
  @IsOptional()
  reason?: SuppressionReason;
}
