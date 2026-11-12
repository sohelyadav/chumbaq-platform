import type { FactorResetVerificationMethod } from '@chumbaq/shared';
import {
  FACTOR_RESET_VERIFICATION_METHODS,
  VERIFICATION_NOTES_MIN,
} from '../modules/factor-resets/entities/factor-reset.entity';
import {
  PASSWORD_RESET_WINDOW_DAYS,
  RECENT_RESET_JUSTIFICATION_MAX,
  RECENT_RESET_JUSTIFICATION_MIN,
} from '../modules/factor-resets/password-reset-window';

export interface FactorsResetVerification {
  method: FactorResetVerificationMethod;
  notes: string;
  /** Why to go ahead although the password was reset recently. Needed only then. */
  recentResetJustification?: string | null;
}

const JUSTIFICATION_FLAG = '--recent-reset-justification';

const JUSTIFICATION_USAGE =
  `  ${JUSTIFICATION_FLAG} "<why>" is needed if the password was reset in the last ` +
  `${PASSWORD_RESET_WINDOW_DAYS} days`;

export const FACTORS_RESET_USAGE =
  'npm run admin:factors-reset -- <email> --verified-by <method> --notes "<how you verified them>" ' +
  `[${JUSTIFICATION_FLAG} "<why>"]\n` +
  `  methods: ${FACTOR_RESET_VERIFICATION_METHODS.join(', ')}\n` +
  JUSTIFICATION_USAGE;

export const PASSKEYS_RESET_USAGE =
  `npm run admin:passkeys-reset -- <email> [${JUSTIFICATION_FLAG} "<why>"]\n` + JUSTIFICATION_USAGE;

/** Each flag once, each with a value. Only `allowed` flags are accepted. */
function readFlags(args: string[], allowed: string[]): Map<string, string> | { error: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag, value] = [args[i], args[i + 1]];
    if (!allowed.includes(flag)) return { error: `Unknown argument ${flag}` };
    if (value === undefined || value.startsWith('--')) return { error: `${flag} needs a value` };
    if (values.has(flag)) return { error: `${flag} given twice` };
    values.set(flag, value);
  }
  return values;
}

/** Null when not given; the same bounds as the panel's `recentResetJustification`. */
function readJustification(values: Map<string, string>): { value: string | null } | { error: string } {
  if (!values.has(JUSTIFICATION_FLAG)) return { value: null };
  const value = values.get(JUSTIFICATION_FLAG)!.trim();
  if (value.length < RECENT_RESET_JUSTIFICATION_MIN || value.length > RECENT_RESET_JUSTIFICATION_MAX) {
    return {
      error:
        `${JUSTIFICATION_FLAG} must say why the recent password reset does not matter, in ` +
        `${RECENT_RESET_JUSTIFICATION_MIN} to ${RECENT_RESET_JUSTIFICATION_MAX} characters`,
    };
  }
  return { value };
}

/**
 * The CLI removes every factor at once, so it asks the same as the panel: how the
 * person was verified, by some means other than email, and what was seen, and after a
 * recent password reset why to go ahead. Returns an error message rather than
 * throwing, so the caller decides how to fail.
 */
export function parseFactorsResetArgs(
  args: string[],
): { verification: FactorsResetVerification } | { error: string } {
  const values = readFlags(args, ['--verified-by', '--notes', JUSTIFICATION_FLAG]);
  if (!(values instanceof Map)) return values;
  const method = values.get('--verified-by');
  const notes = values.get('--notes')?.trim() ?? '';
  if (!method || !(FACTOR_RESET_VERIFICATION_METHODS as readonly string[]).includes(method)) {
    return { error: `--verified-by must be one of ${FACTOR_RESET_VERIFICATION_METHODS.join(', ')}` };
  }
  if (notes.length < VERIFICATION_NOTES_MIN) {
    return { error: `--notes must say how you verified them, in at least ${VERIFICATION_NOTES_MIN} characters` };
  }
  const justification = readJustification(values);
  if ('error' in justification) return justification;
  return {
    verification: {
      method: method as FactorResetVerificationMethod,
      notes,
      recentResetJustification: justification.value,
    },
  };
}

const FACTOR_RESET_JUSTIFICATION_FLAG = '--recent-factor-reset-justification';
const CONFIRM_SUPER_ADMIN_FLAG = '--confirm-super-admin';

export const PASSWORD_RESET_LINK_USAGE =
  'npm run admin:password-reset-link -- <email> --verified-by <method> --notes "<how you verified them>" ' +
  `[${FACTOR_RESET_JUSTIFICATION_FLAG} "<why>"] [${CONFIRM_SUPER_ADMIN_FLAG}]\n` +
  `  methods: ${FACTOR_RESET_VERIFICATION_METHODS.join(', ')}\n` +
  `  ${FACTOR_RESET_JUSTIFICATION_FLAG} "<why>" is needed if staff removed their factors in the last ` +
  `${PASSWORD_RESET_WINDOW_DAYS} days\n` +
  `  ${CONFIRM_SUPER_ADMIN_FLAG} is needed if the account is a super admin`;

export interface PasswordResetLinkRequest extends Pick<FactorsResetVerification, 'method' | 'notes'> {
  /** Why to go ahead although staff removed the factors recently. Needed only then. */
  recentFactorResetJustification?: string | null;
  /** Says the operator knows the account is staff. Needed only then. */
  confirmSuperAdmin?: boolean;
}

/**
 * `admin:password-reset-link` hands over a link that works even inside the window after
 * a factor reset, so it asks the same as the factor resets: how the person was
 * verified, by some means other than email, and what was seen. Inside that window,
 * which is the usual case, it also needs its own justification, and for a super admin
 * a flag saying the operator knows it. `--confirm-super-admin` is the one flag with no
 * value.
 */
export function parsePasswordResetLinkArgs(
  args: string[],
): { verification: Required<PasswordResetLinkRequest> } | { error: string } {
  const confirmations = args.filter((arg) => arg === CONFIRM_SUPER_ADMIN_FLAG).length;
  if (confirmations > 1) return { error: `${CONFIRM_SUPER_ADMIN_FLAG} given twice` };
  const rest = args.filter((arg) => arg !== CONFIRM_SUPER_ADMIN_FLAG);
  const values = readFlags(rest, ['--verified-by', '--notes', FACTOR_RESET_JUSTIFICATION_FLAG]);
  if (!(values instanceof Map)) return values;
  const parsed = parseFactorsResetArgs([
    '--verified-by',
    values.get('--verified-by') ?? '',
    '--notes',
    values.get('--notes') ?? '',
  ]);
  if ('error' in parsed) return parsed;
  let justification: string | null = null;
  if (values.has(FACTOR_RESET_JUSTIFICATION_FLAG)) {
    justification = values.get(FACTOR_RESET_JUSTIFICATION_FLAG)!.trim();
    if (
      justification.length < RECENT_RESET_JUSTIFICATION_MIN ||
      justification.length > RECENT_RESET_JUSTIFICATION_MAX
    ) {
      return {
        error:
          `${FACTOR_RESET_JUSTIFICATION_FLAG} must say why a link is right so soon after the factor ` +
          `reset, in ${RECENT_RESET_JUSTIFICATION_MIN} to ${RECENT_RESET_JUSTIFICATION_MAX} characters`,
      };
    }
  }
  return {
    verification: {
      method: parsed.verification.method,
      notes: parsed.verification.notes,
      recentFactorResetJustification: justification,
      confirmSuperAdmin: confirmations === 1,
    },
  };
}

/** `admin:passkeys-reset` takes only the justification for a recent password reset. */
export function parsePasskeysResetArgs(
  args: string[],
): { recentResetJustification: string | null } | { error: string } {
  const values = readFlags(args, [JUSTIFICATION_FLAG]);
  if (!(values instanceof Map)) return values;
  const justification = readJustification(values);
  if ('error' in justification) return justification;
  return { recentResetJustification: justification.value };
}
