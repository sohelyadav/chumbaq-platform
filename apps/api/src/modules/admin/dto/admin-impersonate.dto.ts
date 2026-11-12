import { Transform, TransformFnParams } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';

/**
 * Reads the raw input: `enableImplicitConversion` has already turned an object
 * into "[object Object]" by the time `value` arrives, which would pass as a reason.
 */
function trimRawString({ key, obj }: TransformFnParams): unknown {
  const raw = obj[key];
  return typeof raw === 'string' ? raw.trim() : raw;
}

export class AdminImpersonateDto {
  /** Trimmed before the length check, so padding cannot stand in for a reason. */
  @Transform(trimRawString)
  @IsString()
  @Length(10, 500)
  @Matches(/^[^\0]*$/, { message: '$property must not contain null characters' })
  reason: string;
}
