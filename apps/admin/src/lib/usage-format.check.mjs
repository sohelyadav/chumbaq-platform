/**
 * Checks for `usage-format.ts`. The admin app has no test runner, so these run
 * with nothing but node. Runs west of Greenwich, where reading a bare date as a
 * UTC instant would show the day before.
 *
 *     npm run test:logic -w @chumbaq/admin
 */
process.env.TZ = 'America/Los_Angeles';

import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  USAGE_METRIC_LABELS,
  TREND_METRICS,
  countedThroughLabel,
  formatCount,
  formatDay,
  formatShortDay,
  messagesSent,
  nextSort,
  readTenantListParams,
  trendPoints,
  writeTenantListParams,
} = await jiti.import(path.join(here, 'usage-format.ts'));

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

const METRICS = [
  'push_sent',
  'email_sent',
  'sms_sent',
  'whatsapp_sent',
  'messages_failed',
  'in_app_impressions',
  'clicks',
  'events',
  'new_people',
  'mau_month_to_date',
  'api_keys_active',
];
const values = (overrides = {}) => ({ ...Object.fromEntries(METRICS.map((m) => [m, null])), ...overrides });

console.log('formatCount');
check('null is a dash, not 0', formatCount(null) === '—', formatCount(null));
check('undefined is a dash', formatCount(undefined) === '—', formatCount(undefined));
check('zero is "0"', formatCount(0) === '0', formatCount(0));
check('thousands separators', formatCount(12480) === '12,480', formatCount(12480));
check('millions', formatCount(1234567) === '1,234,567', formatCount(1234567));

console.log('countedThroughLabel and days');
const coverage = { startedOn: '2026-11-14', countedFrom: '2026-08-16', countedThrough: '2026-11-13', mauFrom: '2026-11-01' };
check('nothing counted yet', countedThroughLabel(null) === 'Not counted yet', countedThroughLabel(null));
check(
  'coverage with no closed day is not counted yet',
  countedThroughLabel({ ...coverage, countedThrough: null }) === 'Not counted yet',
);
check(
  'the day as written, not shifted to the day before',
  countedThroughLabel(coverage) === 'Counted through 13 Nov 2026',
  countedThroughLabel(coverage),
);
check('first of the month stays the first', formatDay('2026-11-01') === '1 Nov 2026', formatDay('2026-11-01'));
check('short day', formatShortDay('2026-01-31') === '31 Jan', formatShortDay('2026-01-31'));

console.log('messagesSent');
check(
  'sums the four channels, null as nothing',
  messagesSent(values({ push_sent: 2, email_sent: null, sms_sent: 0, whatsapp_sent: 1, events: 50 })) === 3,
);
check('all null is null, not 0', messagesSent(values()) === null);
check('all zero is 0', messagesSent(values({ push_sent: 0, email_sent: 0, sms_sent: 0, whatsapp_sent: 0 })) === 0);

console.log('trendPoints');
const points = trendPoints(
  [
    { date: '2026-10-31', values: values({ mau_month_to_date: null, events: 4 }) },
    { date: '2026-11-01', values: values({ mau_month_to_date: 7, events: 0 }) },
  ],
  'mau_month_to_date',
);
check(
  'keeps a null as a gap',
  JSON.stringify(points) ===
    JSON.stringify([
      { date: '2026-10-31', value: null },
      { date: '2026-11-01', value: 7 },
    ]),
  JSON.stringify(points),
);
check('a 0 stays 0', trendPoints([{ date: '2026-11-01', values: values({ events: 0 }) }], 'events')[0].value === 0);

console.log('labels');
check('every metric has a label', Object.keys(USAGE_METRIC_LABELS).length === 11);
check('labels match the metrics', METRICS.every((m) => typeof USAGE_METRIC_LABELS[m] === 'string'));
check('trend has everything but active keys', TREND_METRICS.length === 10 && !TREND_METRICS.includes('api_keys_active'));

console.log('readTenantListParams');
const read = (query) => JSON.stringify(readTenantListParams(new URLSearchParams(query)));
check(
  'unknown values fall back to the defaults',
  read('sort=email&order=sideways&activity=dormant') === JSON.stringify({ sort: 'created_at', order: 'desc' }),
  read('sort=email&order=sideways&activity=dormant'),
);
check('empty is the defaults', read('') === JSON.stringify({ sort: 'created_at', order: 'desc' }), read(''));
const known = readTenantListParams(new URLSearchParams('sort=last_usage_day&order=asc&activity=quiet'));
check(
  'known values are read',
  JSON.stringify(known) === JSON.stringify({ sort: 'last_usage_day', order: 'asc', activity: 'quiet' }),
  JSON.stringify(known),
);
const written = writeTenantListParams(new URLSearchParams('search=acme&page=3'), known);
check(
  'round-trips through the URL',
  JSON.stringify(readTenantListParams(written)) === JSON.stringify(known),
  written.toString(),
);
check('keeps other filters', written.get('search') === 'acme');
check('a change goes back to page 1', !written.has('page'), written.toString());

console.log('writeTenantListParams');
const defaults = writeTenantListParams(
  new URLSearchParams('sort=mau_this_month&order=asc&activity=new&status=active'),
  { sort: 'created_at', order: 'desc', activity: null },
);
check('defaults leave the URL', defaults.toString() === 'status=active', defaults.toString());
const untouched = writeTenantListParams(new URLSearchParams('activity=quiet&sort=mau_this_month'), { order: 'asc' });
check(
  'leaves what was not changed',
  untouched.get('activity') === 'quiet' && untouched.get('sort') === 'mau_this_month' && untouched.get('order') === 'asc',
  untouched.toString(),
);
const input = new URLSearchParams('page=2');
writeTenantListParams(input, { activity: 'new' });
check('the input keeps its page', input.get('page') === '2', input.toString());

console.log('nextSort');
const same = JSON.stringify(nextSort({ sort: 'messages_sent_30d', order: 'desc' }, 'messages_sent_30d'));
check('same column flips to asc', same === JSON.stringify({ sort: 'messages_sent_30d', order: 'asc' }), same);
const back = JSON.stringify(nextSort({ sort: 'messages_sent_30d', order: 'asc' }, 'messages_sent_30d'));
check('and back to desc', back === JSON.stringify({ sort: 'messages_sent_30d', order: 'desc' }), back);
const other = JSON.stringify(nextSort({ sort: 'messages_sent_30d', order: 'asc' }, 'last_usage_day'));
check('a new column starts desc', other === JSON.stringify({ sort: 'last_usage_day', order: 'desc' }), other);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
