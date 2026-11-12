// Exact text the admin API answers with (apps/api/src/modules/staff-auth/staff-messages.ts,
// auth/guards/recent-auth.guard.ts, admin/guards/super-admin.guard.ts). The client
// decides what to do by matching these, so change them in both places together.

export const STAFF_SESSION_IDLE_MESSAGE = 'Signed out after a period of inactivity.';
export const STAFF_SESSION_ENDED_MESSAGE = 'Your staff session has ended. Sign in again.';
export const STAFF_ENROLMENT_ONLY_MESSAGE = 'Finish setting up your sign-in methods first.';
export const STAFF_ENROLMENT_BLOCKED_MESSAGE =
  'Staff sign-in is not set up for this account. Enter the enrolment code from your operator.';
export const REAUTH_REQUIRED_MESSAGE = 'Confirm it is you to continue.';
export const PASSKEY_REQUIRED_MESSAGE = 'Staff access needs two passkeys and a passkey sign-in.';
