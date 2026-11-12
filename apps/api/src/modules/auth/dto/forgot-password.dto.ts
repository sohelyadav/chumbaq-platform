import { NormaliseEmail } from '../../users/email';
import { IsEmail } from 'class-validator';

export class ForgotPasswordDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;
}
