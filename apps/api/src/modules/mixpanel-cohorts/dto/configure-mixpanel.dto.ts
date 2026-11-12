import { IsString, IsNotEmpty, MaxLength } from 'class-validator';

export class ConfigureMixpanelDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  serviceAccountUsername: string;

  @IsString()
  @IsNotEmpty()
  serviceAccountPassword: string;

  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  mixpanelProjectId: string;
}
