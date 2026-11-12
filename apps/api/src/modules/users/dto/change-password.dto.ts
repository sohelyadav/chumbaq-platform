import { IsString, MinLength } from 'class-validator';
import { IsNewPassword } from '../password';

export class ChangePasswordDto {
  @IsString()
  @MinLength(6, { message: 'Password must be at least 6 characters long' })
  currentPassword: string;

  @IsNewPassword()
  newPassword: string;
}
