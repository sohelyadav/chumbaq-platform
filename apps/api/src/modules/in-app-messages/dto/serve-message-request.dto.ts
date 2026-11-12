import { IsString, IsOptional, IsObject, IsInt, Min } from 'class-validator';

export class MessageCheckContextDto {
  @IsOptional()
  @IsString()
  screen?: string;

  @IsOptional()
  @IsString()
  event?: string;

  @IsString()
  platform: string;

  @IsOptional()
  @IsString()
  appVersion?: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  sessionDuration?: number;

  @IsOptional()
  @IsString()
  country?: string;

  @IsOptional()
  @IsString()
  language?: string;
}

export class ServeMessageRequestDto {
  @IsString()
  projectId: string;

  @IsString()
  deviceFingerprint: string;

  @IsOptional()
  @IsString()
  distinctId?: string;

  @IsObject()
  context: MessageCheckContextDto;
}
