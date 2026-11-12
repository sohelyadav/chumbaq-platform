import { IsString, Matches } from 'class-validator';

export class ImpersonationExchangeDto {
  /** 32 random bytes, base64url: exactly what `ImpersonationHandoffsService.create` makes. */
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{43}$/, { message: 'code is not a view-as code' })
  code: string;
}
