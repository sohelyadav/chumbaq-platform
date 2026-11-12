import {
  IsString,
  IsUUID,
  IsOptional,
  IsObject,
  MaxLength,
  IsDateString,
} from 'class-validator';

export class TrackEventDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(255)
  eventName: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  distinctId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  deviceFingerprint?: string;

  @IsObject()
  @IsOptional()
  properties?: Record<string, unknown>;

  @IsDateString()
  @IsOptional()
  timestamp?: string;
}
