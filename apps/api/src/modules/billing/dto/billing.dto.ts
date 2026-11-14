import { Transform, TransformFnParams, Type } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, Matches, ValidateNested } from 'class-validator';
import { GST_STATE_CODES, GSTIN_PATTERN, normaliseGstin } from '../gstin';
import { BILLING_INTERVAL_VALUES } from '../billing-values';
import type { BillingInterval } from '@chumbaq/shared';

/**
 * Reads the raw input: `enableImplicitConversion` has already turned an object into
 * "[object Object]" by the time `value` arrives.
 */
function trimmed({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  return typeof raw === 'string' ? raw.trim() : raw;
}

/** Trimmed; an empty optional field is no field. */
function optionalTrimmed({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  if (typeof raw !== 'string') return raw;
  const value = raw.trim();
  return value === '' ? undefined : value;
}

function gstin({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  if (typeof raw !== 'string') return raw;
  const value = normaliseGstin(raw);
  return value === '' ? undefined : value;
}

const NO_CONTROL = /^[^\0-\x1f\x7f]*$/;
const NO_CONTROL_MESSAGE = '$property must not contain control characters';

export class BillingAddressDto {
  @Transform(trimmed)
  @IsString()
  @Length(1, 200)
  @Matches(NO_CONTROL, { message: NO_CONTROL_MESSAGE })
  line1: string;

  @IsOptional()
  @Transform(optionalTrimmed)
  @IsString()
  @Length(1, 200)
  @Matches(NO_CONTROL, { message: NO_CONTROL_MESSAGE })
  line2?: string;

  @Transform(trimmed)
  @IsString()
  @Length(1, 100)
  @Matches(NO_CONTROL, { message: NO_CONTROL_MESSAGE })
  city: string;

  @Transform(trimmed)
  @IsString()
  @Matches(/^[1-9][0-9]{5}$/, { message: 'postalCode must be a six-digit PIN code' })
  postalCode: string;

  @IsIn(['IN'])
  country: 'IN';
}

/** What an account gives before its first payment: the details on its tax invoices. */
export class BillingDetailsDto {
  @Transform(trimmed)
  @IsString()
  @Length(2, 200)
  @Matches(NO_CONTROL, { message: NO_CONTROL_MESSAGE })
  legalName: string;

  /**
   * Upper-cased and trimmed before the check. Its state digits must be a GST state
   * and equal `stateCode`, which the service checks (it needs both fields).
   */
  @IsOptional()
  @Transform(gstin)
  @IsString()
  @Matches(GSTIN_PATTERN, { message: 'gstin must be a valid GSTIN' })
  gstin?: string;

  @ValidateNested()
  @Type(() => BillingAddressDto)
  address: BillingAddressDto;

  @IsIn(GST_STATE_CODES)
  stateCode: string;
}

/** A plan and interval to buy or move to. The price always comes from the server's rows. */
export class ChoosePlanDto {
  @IsString()
  @Matches(/^[a-z][a-z0-9_]{1,31}$/, { message: 'plan must be a plan code' })
  plan: string;

  @IsIn(BILLING_INTERVAL_VALUES)
  interval: BillingInterval;
}

