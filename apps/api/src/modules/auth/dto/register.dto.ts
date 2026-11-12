import { NormaliseEmail } from '../../users/email';
import { IsNewPassword } from '../../users/password';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

export class RegisterDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsNewPassword()
  password: string;

  @IsString()
  @MinLength(1, { message: 'Name is required' })
  @MaxLength(255)
  name: string;
}
