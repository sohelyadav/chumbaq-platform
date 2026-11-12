import { IsEmail, IsOptional } from 'class-validator';

export class AdminTestEmailDto {
  /** Defaults to the admin's own address. */
  @IsOptional()
  @IsEmail()
  to?: string;
}
