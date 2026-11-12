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
