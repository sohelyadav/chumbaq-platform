import { Transform, TransformFnParams } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsString, Length, Matches, Max, Min, ValidateIf } from 'class-validator';
import type { BillingInterval } from '@chumbaq/shared';
import { BILLING_INTERVAL_VALUES } from '../../billing/billing-values';

/** The same rule as the `plans.code` CHECK. */
export const PLAN_CODE_PATTERN = /^[a-z][a-z0-9_]{1,31}$/;
/** Razorpay's plan ids: `plan_` and 14 letters and digits. */
export const RAZORPAY_PLAN_ID_PATTERN = /^plan_[A-Za-z0-9]{14}$/;
/** The same range as the staff project-limit override. */
export const PLAN_PROJECT_LIMIT_MAX = 1000;
export const PLAN_SORT_ORDER_MAX = 1000;
/** A typo of a few extra zeros is refused rather than charged: ten lakh rupees. */
export const PRICE_PAISE_MAX = 100_000_000;

/** Reads the raw input: implicit conversion would have made an object "[object Object]". */
function trimRawString({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  return typeof raw === 'string' ? raw.trim() : raw;
}

const present = (value: unknown) => value !== undefined;
const presentNotNull = (value: unknown) => value !== undefined && value !== null;

export class AdminPlanReasonDto {
  @Transform(trimRawString)
  @IsString()
  @Length(3, 500)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  reason: string;
}

/**
 * A new plan. Each limit must be given: null is unlimited for MAU and seats, and the
 * install's default for projects.
 */
export class AdminCreatePlanDto extends AdminPlanReasonDto {
  @IsString()
  @Matches(PLAN_CODE_PATTERN, { message: 'code must be 2 to 32 lower-case letters, digits or _, starting with a letter' })
  code: string;

  @Transform(trimRawString)
  @IsString()
  @Length(1, 60)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  name: string;

  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  mauLimit: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(PLAN_PROJECT_LIMIT_MAX)
  projectLimit: number | null;

  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  seatLimit: number | null;

  @IsInt()
  @Min(0)
  @Max(PLAN_SORT_ORDER_MAX)
  sortOrder: number;
}

/**
 * A change to a plan: only the fields sent change. A limit sent as null is cleared;
 * the other fields refuse null.
 */
export class AdminUpdatePlanDto extends AdminPlanReasonDto {
  @ValidateIf((o: AdminUpdatePlanDto) => present(o.name))
  @Transform(trimRawString)
  @IsString()
  @Length(1, 60)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  name?: string;

  @ValidateIf((o: AdminUpdatePlanDto) => presentNotNull(o.mauLimit))
  @IsInt()
  @Min(1)
  mauLimit?: number | null;

  @ValidateIf((o: AdminUpdatePlanDto) => presentNotNull(o.projectLimit))
  @IsInt()
  @Min(1)
  @Max(PLAN_PROJECT_LIMIT_MAX)
  projectLimit?: number | null;

  @ValidateIf((o: AdminUpdatePlanDto) => presentNotNull(o.seatLimit))
  @IsInt()
  @Min(1)
  seatLimit?: number | null;

  @ValidateIf((o: AdminUpdatePlanDto) => present(o.sortOrder))
  @IsInt()
  @Min(0)
  @Max(PLAN_SORT_ORDER_MAX)
  sortOrder?: number;

  @ValidateIf((o: AdminUpdatePlanDto) => present(o.isActive))
  // The raw value: implicit conversion would read the string "false" as true.
  @Transform(({ key, obj }: TransformFnParams) => obj[key])
  @IsBoolean()
  isActive?: boolean;
}

/**
 * A new price, excluding GST. The charged amount is never sent: the server works it
 * out and checks it against the provider's plan.
 */
export class AdminAddPriceDto extends AdminPlanReasonDto {
  @IsIn(BILLING_INTERVAL_VALUES)
  interval: BillingInterval;

  @IsInt()
  @Min(1)
  @Max(PRICE_PAISE_MAX)
  pricePaise: number;

  @IsString()
  @Matches(RAZORPAY_PLAN_ID_PATTERN, { message: 'razorpayPlanId must be a Razorpay plan id (plan_ and 14 letters or digits)' })
  razorpayPlanId: string;
}
