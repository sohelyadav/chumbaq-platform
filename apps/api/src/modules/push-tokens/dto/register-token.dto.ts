import { IsString, IsUUID, IsOptional, IsIn } from 'class-validator';
import { PUSH_PROVIDERS, PushProvider } from '../entities/push-token.entity';

export class RegisterPushTokenDto {
  @IsUUID()
  projectId: string;

  @IsString()
  deviceFingerprint: string;

  @IsString()
  token: string;

  @IsIn(['ios', 'android', 'web'])
  platform: 'ios' | 'android' | 'web';

  /**
   * Which channel this token addresses. Read from the shared list so a client
   * cannot register a provider the sender has no way to deliver through.
   */
  @IsIn(PUSH_PROVIDERS as unknown as string[])
  @IsOptional()
  provider?: PushProvider;
}
