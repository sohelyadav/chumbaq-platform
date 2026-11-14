/**
 * Checks for `admin-audit-filters.ts`. Same reasoning as `segment-form.check.mjs`:
 * `apps/web` has no test runner. Runs in a fixed timezone, because "the end date
 * counts in full" is only meaningful against a zone that is not UTC.
 *
 *     npm run test:logic -w @chumbaq/web
 */
process.env.TZ = 'Asia/Kolkata';

import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { AUDIT_ACTIONS, AUDIT_ACTION_LABELS, EMPTY_FILTER_FORM, filterFormError, readFilterForm, toApiFilters, writeFilterForm } =
  await jiti.import(path.join(here, 'admin-audit-filters.ts'));

let passed = 0;
const failures = [];

function check(label, condition, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ok    ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
  }
}

const KNOWN = ['tenant.viewed', 'tenant.suspended', 'audit_log.exported'];
const form = (over) => ({ ...EMPTY_FILTER_FORM, ...over });

{
  const api = toApiFilters(form({ fromDate: '2026-11-01', toDate: '2026-11-01' }));
  check(
    'a one-day range is that local day, start inclusive and the next midnight exclusive',
    api.from === '2026-10-31T18:30:00.000Z' && api.to === '2026-11-01T18:30:00.000Z',
    JSON.stringify(api),
  );
}

{
  const api = toApiFilters(form({ toDate: '2026-12-31' }));
  check('an end date at the year end rolls into the next year', api.to === '2026-12-31T18:30:00.000Z', api.to);
}

{
  const api = toApiFilters(form({ actorEmail: '  ops@chumbaq.com ', targetId: ' ' }));
  check('trims text and leaves blank filters out', JSON.stringify(api) === '{"actorEmail":"ops@chumbaq.com"}', JSON.stringify(api));
}

{
  const read = readFilterForm(new URLSearchParams('action=tenant.viewed,tenant.deleted,audit_log.exported&from=2026-11-01'), KNOWN);
  check(
    'drops unknown actions from a pasted URL and keeps the known ones in order',
    JSON.stringify(read.actions) === '["tenant.viewed","audit_log.exported"]',
    JSON.stringify(read.actions),
  );
  check('reads the dates back as typed', read.fromDate === '2026-11-01' && read.toDate === '');
  const round = writeFilterForm(read);
  check(
    'writes back what it read',
    JSON.stringify(round) === '{"action":"tenant.viewed,audit_log.exported","from":"2026-11-01"}',
    JSON.stringify(round),
  );
}

check('an empty action param is no filter', readFilterForm(new URLSearchParams('action='), KNOWN).actions.length === 0);

check('refuses a partial tenant ID', filterFormError(form({ targetId: 'e8600afc' })) !== null);
check(
  'accepts a full tenant ID',
  filterFormError(form({ targetId: 'e8600afc-f4a8-4b79-ade2-64491611c32d' })) === null,
);
check('refuses an end before the start', filterFormError(form({ fromDate: '2026-11-02', toDate: '2026-11-01' })) !== null);
check('accepts the same start and end day', filterFormError(form({ fromDate: '2026-11-01', toDate: '2026-11-01' })) === null);
check('refuses a date that is not YYYY-MM-DD', filterFormError(form({ fromDate: '11/01/2026' })) !== null);

{
  const BILLING = [
    'billing.plan_created',
    'billing.plan_updated',
    'billing.price_added',
    'billing.price_retired',
    'billing.comp_granted',
    'billing.comp_ended',
    'billing.subscription_cancelled',
    'billing.invoice_resent',
  ];
  const missing = BILLING.filter((a) => !AUDIT_ACTIONS.includes(a) || !AUDIT_ACTION_LABELS[a]);
  check('every billing action can be filtered on and has a label', missing.length === 0, missing.join(', '));
  const read = readFilterForm(new URLSearchParams(`action=${BILLING.join(',')},billing.refunded`), AUDIT_ACTIONS);
  check(
    'a pasted URL keeps the billing actions and drops an unknown one',
    JSON.stringify(read.actions) === JSON.stringify(BILLING),
    JSON.stringify(read.actions),
  );
  check(
    'and sends them to the API as written',
    JSON.stringify(toApiFilters(read).action) === JSON.stringify(BILLING),
    JSON.stringify(toApiFilters(read)),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
