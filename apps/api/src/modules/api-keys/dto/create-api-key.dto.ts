import {
  IsString,
  IsOptional,
  IsArray,
  IsDateString,
  IsIn,
  MaxLength,
  ArrayMaxSize,
} from 'class-validator';
import { API_KEY_PERMISSIONS } from '../api-key-permissions';

export class CreateApiKeyDto {
  @IsString()
  @MaxLength(255)
  name: string;

  /**
   * Omitted means `['read', 'write']`. `['privacy']` makes a server-only key
   * for the privacy API, and must be alone (see `permissionsForNewKey`).
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(API_KEY_PERMISSIONS.length)
  @IsIn(API_KEY_PERMISSIONS as string[], { each: true })
  permissions?: string[];

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
