// Exact text the admin app matches on. Change it there too.

export const STAFF_ENROLMENT_ONLY_MESSAGE = 'Finish setting up your sign-in methods first.';
/**
 * A correct password that may not start enrolment without an operator's code, or came
 * with a wrong, spent or expired one: one answer for all, so it says nothing about the
 * code. The admin app shows the code field on this text.
 */
export const STAFF_ENROLMENT_BLOCKED_MESSAGE =
  'Staff sign-in is not set up for this account. Enter the enrolment code from your operator.';
export const STAFF_SESSION_IDLE_MESSAGE = 'Signed out after a period of inactivity.';
export const STAFF_SESSION_ENDED_MESSAGE = 'Your staff session has ended. Sign in again.';
export const STAFF_LAST_FACTOR_MESSAGE = 'Add another sign-in method before removing this one.';
export const PASSKEY_NOT_RECOGNISED_MESSAGE = 'That passkey is not recognised.';
/** Answered by the customer API to a super admin changing what is also their staff sign-in. */
export const STAFF_MANAGE_IN_ADMIN_MESSAGE = 'Manage staff sign-in in the admin app.';
/**
 * Answered by the customer API to a correct password on an account whose only passkeys
 * are staff ones. Those keys belong to the admin app's relying party and cannot answer
 * here, but a password alone must not replace them. The authenticator app is shared.
 */
export const STAFF_KEYS_ONLY_MESSAGE =
  'Your staff passkeys work only in the admin app. Add an authenticator app there to sign in here.';
/** Answered by the customer API when a super admin would be left with no factor there. */
export const STAFF_KEEP_CUSTOMER_FACTOR_MESSAGE =
  'Staff accounts must keep a second factor here. Add another passkey before removing this one.';
