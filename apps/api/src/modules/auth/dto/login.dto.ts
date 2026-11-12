import { NormaliseEmail } from '../../users/email';
import { IsEmail, IsString, MinLength } from 'class-validator';

export class LoginDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;
}
