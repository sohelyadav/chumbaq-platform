import { IsString } from 'class-validator';
import { IsNewPassword } from '../../users/password';

export class ResetPasswordDto {
  /** Only ever hashed and compared, so its length needs no limit beyond the body's. */
  @IsString()
  token: string;

  @IsNewPassword()
  newPassword: string;
}

export class ResetLinkStatusDto {
  @IsString()
  token: string;
}
