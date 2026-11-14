import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsISO8601, IsOptional, IsString, Matches } from 'class-validator';
import { AdminTenantReasonDto } from './admin-tenants.dto';
import { PLAN_CODE_PATTERN } from './admin-plans.dto';

/** Gives an account a plan without payment, until `until` (an instant) or until ended. */
export class AdminCompDto extends AdminTenantReasonDto {
  @IsString()
  @Matches(PLAN_CODE_PATTERN, { message: 'planCode must be a plan code' })
  planCode: string;

  /** In the future and within five years, checked against the server's clock. */
  @IsOptional()
  @IsISO8601({ strict: true })
  until?: string;
}

export class AdminCancelSubscriptionDto extends AdminTenantReasonDto {
  // The raw value: implicit conversion would read the string "false" as true.
  @Transform(({ key, obj }: TransformFnParams) => obj[key])
  @IsBoolean()
  atCycleEnd: boolean;
}
