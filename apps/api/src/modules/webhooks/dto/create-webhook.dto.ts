import { IsString, IsArray, IsOptional, IsUrl, IsBoolean, MaxLength } from 'class-validator';

export class CreateWebhookDto {
  @IsUrl()
  @MaxLength(2048)
  url: string;

  @IsArray()
  @IsString({ each: true })
  events: string[];

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
