import { IsIn, IsObject, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { SERVER_ALERT_KINDS } from '../alert-kinds';

export class InternalAlertDto {
  @IsIn(SERVER_ALERT_KINDS)
  kind!: (typeof SERVER_ALERT_KINDS)[number];

  @IsString()
  @Length(1, 200)
  key!: string;

  /** At most 20 entries of strings up to 500 characters; checked by the controller. */
  @IsOptional()
  @IsObject()
  details?: Record<string, unknown>;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  ip?: string;
}
