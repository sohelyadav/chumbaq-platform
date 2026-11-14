import type { AdminAuditAction } from '@chumbaq/shared';

/** What the audit log page edits and keeps in its URL. Dates are `YYYY-MM-DD`, both inclusive. */
export interface AuditFilterForm {
  actions: AdminAuditAction[];
  actorEmail: string;
  targetId: string;
  fromDate: string;
  toDate: string;
}

/** What the API takes. `from` inclusive and `to` exclusive, as instants. */
export interface AuditApiFilters {
  action?: AdminAuditAction[];
  actorEmail?: string;
  targetId?: string;
  from?: string;
  to?: string;
}

export const EMPTY_FILTER_FORM: AuditFilterForm = {
  actions: [],
  actorEmail: '',
  targetId: '',
  fromDate: '',
  toDate: '',
};

/** Every action the log can hold, as the filter lists it. A Record, so an action added to the shared union fails compilation until it has a label. */
export const AUDIT_ACTION_LABELS: Record<AdminAuditAction, string> = {
  'tripwire.created': 'Trap made',
  'tripwire.revoked': 'Trap switched off',
  'incident.recorded': 'Incident recorded',
  'incident.reported': 'Incident marked reported to CERT-In',
  'incident.note_added': 'Incident note added',
  'incident.closed': 'Incident closed',
  'security_contact.updated': 'Security contact changed',
  'tenant.suspended': 'Tenant suspended',
  'tenant.reactivated': 'Tenant reactivated',
  'tenant.impersonated': 'Tenant impersonated',
  'tenant.viewed': 'Tenant viewed by staff',
  'super_admin.granted': 'Super admin granted',
  'super_admin.revoked': 'Super admin revoked',
  'super_admin.passkeys_reset': 'Passkeys reset by CLI',
  'account.factors_reset': 'Second factors reset',
  'audit_log.exported': 'Audit log exported',
  'tenants.exported': 'Tenants list exported',
  'account.factors_reset_requested': 'Second factor reset requested',
  'account.factors_reset_cancelled': 'Second factor reset cancelled',
  'account.password_reset_refused': 'Password reset refused after factor reset',
  'account.password_reset_link_issued': 'Password reset link issued by CLI',
  'account.password_reset_link_cancelled': 'Password reset link cancelled',
  'account.password_reset_link_void_failed': 'Sign-in could not cancel a password reset link',
  'account.project_limit_changed': 'Project limit changed',
  'account.seat_limit_changed': 'Seat limit changed',
  'staff.signed_in': 'Signed in',
  'staff.sign_in_failed': 'Failed sign-in',
  'staff.signed_out': 'Signed out',
  'staff.session_revoked': 'Session ended',
  'staff.enrolment_started': 'Started sign-in setup',
  'staff.enrolment_allowed': 'Enrolment code issued',
  'staff.factor_added': 'Added a sign-in method',
  'staff.factor_removed': 'Removed a sign-in method',
  'tenant.impersonation_exchanged': 'View-as opened',
  'tenant.impersonation_refused': 'View-as link refused',
  'billing.plan_created': 'Plan created',
  'billing.plan_updated': 'Plan changed',
  'billing.price_added': 'Plan price added',
  'billing.price_retired': 'Plan price retired',
  'billing.comp_granted': 'Complimentary plan given',
  'billing.comp_ended': 'Complimentary plan ended',
  'billing.subscription_cancelled': 'Subscription cancelled by staff',
  'billing.invoice_resent': 'Invoice link resent',
};

export const AUDIT_ACTIONS = Object.keys(AUDIT_ACTION_LABELS) as AdminAuditAction[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Midnight at the start of `date` in the browser's timezone, `days` later. The person
 * picking "6 November" means their own 6 November, not UTC's.
 */
function localMidnight(date: string, days = 0): string | undefined {
  const match = DATE.exec(date);
  if (!match) return undefined;
  const [, year, month, day] = match.map(Number);
  return new Date(year, month - 1, day + days).toISOString();
}

/** Unknown actions in a pasted URL are dropped rather than sent for a 400. */
export function readFilterForm(
  params: URLSearchParams,
  known: readonly AdminAuditAction[],
): AuditFilterForm {
  const actions = (params.get('action') ?? '')
    .split(',')
    .filter((value): value is AdminAuditAction => (known as readonly string[]).includes(value));
  return {
    actions,
    actorEmail: params.get('actorEmail') ?? '',
    targetId: params.get('targetId') ?? '',
    fromDate: params.get('from') ?? '',
    toDate: params.get('to') ?? '',
  };
}

export function writeFilterForm(form: AuditFilterForm): Record<string, string> {
  const params: Record<string, string> = {};
  if (form.actions.length) params.action = form.actions.join(',');
  if (form.actorEmail.trim()) params.actorEmail = form.actorEmail.trim();
  if (form.targetId.trim()) params.targetId = form.targetId.trim();
  if (form.fromDate) params.from = form.fromDate;
  if (form.toDate) params.to = form.toDate;
  return params;
}

/** Says what is wrong before the request, rather than leaving a bare 400 to explain it. */
export function filterFormError(form: AuditFilterForm): string | null {
  if (form.targetId.trim() && !UUID.test(form.targetId.trim())) {
    return 'Tenant ID must be a full ID, as shown in the tenant page address.';
  }
  if ((form.fromDate && !DATE.test(form.fromDate)) || (form.toDate && !DATE.test(form.toDate))) {
    return 'Dates must be in the form YYYY-MM-DD.';
  }
  if (form.fromDate && form.toDate && form.toDate < form.fromDate) {
    return 'The end date is before the start date.';
  }
  return null;
}

/** Only call on a form `filterFormError` accepts. The end date counts in full. */
export function toApiFilters(form: AuditFilterForm): AuditApiFilters {
  const filters: AuditApiFilters = {};
  if (form.actions.length) filters.action = form.actions;
  if (form.actorEmail.trim()) filters.actorEmail = form.actorEmail.trim();
  if (form.targetId.trim()) filters.targetId = form.targetId.trim();
  const from = form.fromDate ? localMidnight(form.fromDate) : undefined;
  const to = form.toDate ? localMidnight(form.toDate, 1) : undefined;
  if (from) filters.from = from;
  if (to) filters.to = to;
  return filters;
}

export function hasFilters(form: AuditFilterForm): boolean {
  return Object.keys(writeFilterForm(form)).length > 0;
}
