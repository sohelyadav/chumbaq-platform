import { IsString, IsOptional, IsArray, IsUUID, IsIn } from 'class-validator';

export class TriggerMessageDto {
  @IsUUID()
  messageId: string;

  @IsIn(['all', 'cohort', 'users'])
  targetType: 'all' | 'cohort' | 'users';

  @IsOptional()
  @IsUUID()
  cohortId?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  distinctIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  deviceFingerprints?: string[];
}
