import type { SecurityAlertKind } from '@chumbaq/shared';

/**
 * Runtime copy of the shared `SecurityAlertKind` union (the API must not value-import
 * `@chumbaq/shared`), held to it by the check below, with the line each alarm's email
 * subject uses.
 */
export const SECURITY_ALERT_LABELS = {
  'server.ssh_login': 'someone signed in to the server (SSH)',
  'server.ssh_banned': 'repeated failed server sign-ins, address blocked',
  'server.files_changed': 'important files on the server changed',
  'staff.new_device': 'staff sign-in from a new device',
  'staff.failed_sign_ins': 'repeated failed staff sign-ins',
  'data.bulk_export': 'unusually large data export',
  'data.unusual_reads': 'unusually many data reads by one account',
  'tripwire.api_key': 'the trap API key was used',
  'tripwire.account': 'the trap account was used',
} as const satisfies Record<SecurityAlertKind, string>;

export const SECURITY_ALERT_KINDS = Object.keys(SECURITY_ALERT_LABELS) as SecurityAlertKind[];

/** Kinds the localhost route for server scripts may raise. */
export const SERVER_ALERT_KINDS = ['server.ssh_login', 'server.ssh_banned', 'server.files_changed'] as const;

type SameSet<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const KINDS_MATCH_SHARED: SameSet<keyof typeof SECURITY_ALERT_LABELS, SecurityAlertKind> = true;
void KINDS_MATCH_SHARED;
