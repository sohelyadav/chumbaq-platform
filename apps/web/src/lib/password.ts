import { z } from 'zod';

/**
 * The API's rule for a new password, in `apps/api/src/modules/users/password.ts`: keep the
 * two in step. bcrypt reads only the first 72 bytes, and bytes are not characters: 'é' is
 * two in UTF-8 and most emoji four, so this counts what the server will count.
 */
export const PASSWORD_MAX_BYTES = 72;
export const PASSWORD_MIN_LENGTH = 8;

export const PASSWORD_TOO_SHORT = `Password must be at least ${PASSWORD_MIN_LENGTH} characters`;
export const PASSWORD_TOO_LONG =
  `Password is too long: use at most ${PASSWORD_MAX_BYTES} bytes (about ${PASSWORD_MAX_BYTES} letters ` +
  'or digits; some symbols and non-English letters count as more)';

const encoder = new TextEncoder();

export function passwordBytes(password: string): number {
  return encoder.encode(password).length;
}

/** For a field that sets a password. Never for sign-in, which must take an older, longer one. */
export function newPassword() {
  return z
    .string()
    .min(PASSWORD_MIN_LENGTH, PASSWORD_TOO_SHORT)
    .refine((value) => passwordBytes(value) <= PASSWORD_MAX_BYTES, PASSWORD_TOO_LONG);
}

/**
 * Blank, or a valid new password. Not `newPassword().or(z.literal(''))`, which reports
 * only zod's "Invalid input" and hides which rule was broken.
 */
export function optionalNewPassword() {
  return z
    .string()
    .optional()
    .superRefine((value, ctx) => {
      if (!value) return;
      for (const issue of newPassword().safeParse(value).error?.issues ?? []) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: issue.message });
      }
    });
}
