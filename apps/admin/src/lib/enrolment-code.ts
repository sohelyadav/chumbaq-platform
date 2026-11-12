import { STAFF_ENROLMENT_BLOCKED_MESSAGE } from './messages';

/**
 * Whether the admin API's answer to a password means "this needs an operator's enrolment
 * code". The API gives the same answer for a missing, wrong, spent or expired code, so
 * the field stays up after a wrong one and the person can try again.
 */
export function needsEnrolmentCode(message: string | null): boolean {
  return message === STAFF_ENROLMENT_BLOCKED_MESSAGE;
}

/** The login body. A code is sent only once asked for, trimmed, and never empty. */
export function staffLoginBody(
  email: string,
  password: string,
  enrolmentCode: string | null,
): { email: string; password: string; enrolmentCode?: string } {
  const code = enrolmentCode?.trim();
  return code ? { email, password, enrolmentCode: code } : { email, password };
}
