import { Transform } from 'class-transformer';
import { IsEmail, IsObject, IsOptional, IsString, Length, Matches, MaxLength, MinLength } from 'class-validator';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';
import { NormaliseEmail } from '../../users/email';

export class StaffLoginDto {
  @NormaliseEmail()
  @IsEmail({}, { message: 'Please provide a valid email address' })
  email: string;

  // Checks an existing password, so not `@IsNewPassword`: older, longer ones still work.
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  @MaxLength(200)
  password: string;

  /**
   * From `admin:staff-enrolment`, handed over out of band. Only read when the password
   * is right and enrolment needs it. No format check here, so a malformed code gets the
   * same answer as a wrong one rather than a 400 that tells them apart.
   */
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(200)
  enrolmentCode?: string;
}

export class StaffHandleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  handle: string;
}

export class StaffTotpLoginDto extends StaffHandleDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code: string;
}

export class StaffPasskeyVerifyDto {
  // Checked by the verifier; its shape is the WebAuthn specification's, not ours.
  @IsObject()
  response: AuthenticationResponseJSON;
}

export class StaffPasskeyLoginDto extends StaffPasskeyVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  handle: string;
}

export class StaffPasswordlessDto extends StaffPasskeyVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ceremonyId: string;
}

export class StaffPasskeyRegisterDto {
  @IsObject()
  response: RegistrationResponseJSON;

  @IsString()
  @Length(1, 64)
  name: string;
}

export class StaffCodeDto {
  @IsString()
  @Matches(/^\d{6}$/, { message: 'Enter the 6-digit code' })
  code: string;
}
