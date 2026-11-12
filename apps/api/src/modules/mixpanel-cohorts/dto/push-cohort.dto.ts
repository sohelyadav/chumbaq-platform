import { IsString, IsNotEmpty, IsOptional, MaxLength, IsIn, IsArray } from 'class-validator';

export class PushCohortDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  title: string;

  @IsString()
  @IsOptional()
  @MaxLength(1000)
  body?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  deepLinkUrl?: string;

  @IsArray()
  @IsIn(['android', 'ios', 'web'], { each: true })
  @IsOptional()
  platforms?: Array<'android' | 'ios' | 'web'>;

  @IsOptional()
  data?: Record<string, string>;
}
