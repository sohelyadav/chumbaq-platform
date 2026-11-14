import { NormaliseEmail } from '../../users/email';
import { IsNewPassword } from '../../users/password';
import { IsEmail, IsString, MinLength, MaxLength } from 'class-validator';

/** The first step of signing up; the password is chosen from the mailed link. */
export class RegisterDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  @IsString()
  @MinLength(1, { message: 'Name is required' })
  @MaxLength(255)
  name: string;
}

/** Finishing a sign-up from the mailed link. */
export class CompleteSignupDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  token: string;

  @IsNewPassword()
  password: string;
}
