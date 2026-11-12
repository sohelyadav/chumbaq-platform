import { IsString } from 'class-validator';

export class VerifyEmailDto {
  /** Only ever hashed and compared, so its length needs no limit beyond the body's. */
  @IsString()
  token: string;
}
