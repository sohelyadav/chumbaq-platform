import { IsObject, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server';

export class PasskeyRegisterDto {
  // Checked by the verifier; its shape is the WebAuthn specification's, not ours.
  @IsObject()
  response: RegistrationResponseJSON;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  name?: string;
}

export class PasskeyHandleDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  handle: string;
}

export class PasskeyVerifyDto {
  @IsObject()
  response: AuthenticationResponseJSON;
}

export class PasskeySecondFactorDto extends PasskeyVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  handle: string;
}

export class PasskeyPasswordlessDto extends PasskeyVerifyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  flowId: string;
}
