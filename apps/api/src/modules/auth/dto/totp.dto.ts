import { IsString, MaxLength, MinLength } from 'class-validator';

export class FactorCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code: string;
}

export class LoginFactorCodeDto extends FactorCodeDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  handle: string;
}
