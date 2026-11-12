import { applyDecorators } from '@nestjs/common';
import { IsString, MinLength, ValidateBy } from 'class-validator';

/**
 * bcrypt reads only the first 72 bytes, so two passwords that share them are the same
 * password. Bytes, not characters: 'é' is two in UTF-8 and most emoji four.
 * `apps/web/src/lib/password.ts` mirrors this; keep the two in step.
 */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
export const PASSWORD_TOO_LONG =
  `Password is too long: use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} letters ` +
  'or digits; some symbols and non-English letters count as more)';

export function passwordFitsBcrypt(value: unknown): boolean {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES;
}

/**
 * For every field that sets a password, so the rule cannot drift between them again.
 * Never for one that checks an existing password: an account from before the byte limit
 * must still be able to sign in and change it.
 */
export const IsNewPassword = () =>
  applyDecorators(
    IsString(),
    MinLength(PASSWORD_MIN_LENGTH, { message: PASSWORD_TOO_SHORT }),
    ValidateBy({
      name: 'passwordFitsBcrypt',
      validator: { validate: passwordFitsBcrypt, defaultMessage: () => PASSWORD_TOO_LONG },
    }),
  );
