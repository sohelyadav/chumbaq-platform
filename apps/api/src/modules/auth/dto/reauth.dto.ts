import { IsString, MinLength } from 'class-validator';

export class ReauthDto {
  @IsString()
  @MinLength(1, { message: 'Password is required' })
  password: string;
}
