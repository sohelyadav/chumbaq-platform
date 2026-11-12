/**
 * Checks for `segment-form.ts` — the form/AST translation behind the audience
 * builder.
 *
 * ## Why this is a script and not a test suite
 *
 * `apps/web` has no test runner. Installing vitest failed on this machine with
 * an `EACCES` in the npm cache, and forcing a write into the user's cache is
 * not this script's business. So the assertions live here, runnable with
 * nothing but node:
 *
 *     npm run test:logic -w @chumbaq/web
 *
 * If vitest is ever added, this converts to a `.spec.ts` almost verbatim and
 * should be.
 *
 * `jiti` is used to load TypeScript with the project's path aliases. It is not
 * declared here because it arrives with vite, so it is present whenever the web
 * app can be built or served at all.
 *
 * ## Why these assertions and not others
 *
 * Two properties in this module are load-bearing and fail silently:
 *
 * 1. **Ordered comparisons must bind a real number.** The SQL compiler only
 *    casts a jsonb extraction to numeric when the bound value is
 *    `typeof 'number'`. Bound as text, `revenue > "90"` is a *string*
 *    comparison where "140.01" > "90" is false. Verified against the live API:
 *    the number form matched 12 people, the string form matched 0. Every
 *    "revenue greater than" audience would have silently matched nobody.
 *
 * 2. **An AST the editor cannot represent must be refused, not flattened.**
 *    The AST allows depth 5 and negated groups; the editor offers one level of
 *    grouping and no negation. Flattening the difference would quietly change
 *    who an audience contains, which is the one thing an audience editor must
 *    never do.
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const webSrc = path.resolve(here, '..');
const sharedSrc = path.resolve(here, '../../../../packages/shared/src');

const jiti = createJiti(import.meta.url, {
  alias: { '@': webSrc, '@chumbaq/shared': sharedSrc },
  interopDefault: true,
});

const { toDefinition, fromDefinition, describeProblem, countRules } =
  await jiti.import(path.join(webSrc, 'lib/segment-form.ts'));

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

const leaf = (field, op, value) => ({ type: 'attribute', field, op, value });

// A form covering every row the editor can produce.
const rules = [
  {
    id: 'a', kind: 'event', eventName: 'purchase_completed',
    occurrence: 'at_least', count: '2', withinDays: '90',
    where: [{ id: 'w', property: 'revenue', op: 'gt', value: '90' }],
  },
  {
    id: 'b', kind: 'event', eventName: 'app_opened',
    occurrence: 'none', count: '1', withinDays: '30', where: [],
  },
  { id: 'c', kind: 'attribute', field: 'country', op: 'in', value: 'India, Brazil' },
  {
    id: 'd', kind: 'group', operator: 'or', children: [
      { id: 'e', kind: 'attribute', field: 'platform', op: 'eq', value: 'ios' },
      { id: 'f', kind: 'attribute', field: 'totalRevenue', op: 'gte', value: '500' },
    ],
  },
];

console.log('form -> AST -> form');
const ast = toDefinition(true, rules);
const loaded = fromDefinition(ast);
check('a full form survives the trip back', loaded !== null);
check(
  'and returns to the same AST',
  JSON.stringify(toDefinition(loaded.matchAll, loaded.rules)) === JSON.stringify(ast),
);
check(
  'a bare leaf root loads as a single rule',
  fromDefinition(leaf('city', 'exists', null))?.rules.length === 1,
);

console.log('\nvalue typing');
const revenue = ast.children[0].where[0].value;
check(
  'an ordered op on an event property binds a number',
  typeof revenue === 'number' && revenue === 90,
  `got ${JSON.stringify(revenue)} (${typeof revenue})`,
);
const totalRevenue = ast.children[3].children[1].value;
check(
  'an ordered op on a profile attribute binds a number',
  typeof totalRevenue === 'number' && totalRevenue === 500,
  `got ${JSON.stringify(totalRevenue)} (${typeof totalRevenue})`,
);
check(
  'eq stays text, so traits.tier = "10" is not turned numeric',
  toDefinition(true, [
    { id: 'x', kind: 'attribute', field: 'traits.tier', op: 'eq', value: '10' },
  ]).children[0].value === '10',
);
check(
  '"is one of" becomes a non-empty array, which the API requires',
  Array.isArray(ast.children[2].value) && ast.children[2].value.length === 2,
  JSON.stringify(ast.children[2].value),
);
check(
  '"never" forces the count to zero',
  ast.children[1].count === 0,
  String(ast.children[1].count),
);

console.log('\nrefusing what the editor cannot show');
check(
  'depth 3 is refused rather than flattened',
  fromDefinition({
    type: 'group', operator: 'and', children: [
      { type: 'group', operator: 'or', children: [
        { type: 'group', operator: 'and', children: [leaf('city', 'exists', null)] },
      ]},
    ],
  }) === null,
);
check(
  'a negated root group is refused',
  fromDefinition({
    type: 'group', operator: 'and', negate: true,
    children: [leaf('city', 'exists', null)],
  }) === null,
);
check(
  'a negated inner group is refused',
  fromDefinition({
    type: 'group', operator: 'and', children: [
      { type: 'group', operator: 'or', negate: true, children: [leaf('city', 'exists', null)] },
    ],
  }) === null,
);

console.log('\nvalidation mirrors the API');
const event = (over) => [{
  id: 'y', kind: 'event', eventName: 'login', occurrence: 'at_least',
  count: '1', withinDays: '30', where: [], ...over,
}];
check('an empty rule list is reported', describeProblem([]) !== null);
check('withinDays 400 is reported', describeProblem(event({ withinDays: '400' })) !== null);
check('withinDays 365 is allowed', describeProblem(event({ withinDays: '365' })) === null);
check('a missing event name is reported', describeProblem(event({ eventName: '' })) !== null);
check(
  'an unsafe property name is reported before the API sees it',
  describeProblem(event({ where: [{ id: 'w', property: "a'; DROP TABLE", op: 'eq', value: 'x' }] })) !== null,
);
check('a valid form reports nothing', describeProblem(rules) === null);
check(
  'property filters count toward the 50-rule ceiling',
  countRules(rules) === 6,
  `got ${countRules(rules)}`,
);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
