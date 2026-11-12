/**
 * Checks for `project-limit.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { canCreateProject, parseProjectLimitInput, projectCountLabel } = await jiti.import(
  path.join(here, 'project-limit.ts'),
);

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

console.log('projectCountLabel');
check('"3 of 10 projects"', projectCountLabel(3, 10) === '3 of 10 projects', projectCountLabel(3, 10));
check('singular limit', projectCountLabel(0, 1) === '0 of 1 project', projectCountLabel(0, 1));

console.log('canCreateProject');
check('room left', canCreateProject(9, 10) === true);
check('at the limit', canCreateProject(10, 10) === false);
// Accounts from before the limit, or whose limit staff lowered, keep their projects.
check('over the limit', canCreateProject(14, 10) === false);
check('limit not loaded yet: leave it to the server', canCreateProject(14, undefined) === true);

console.log('parseProjectLimitInput');
const parsed = (text) => JSON.stringify(parseProjectLimitInput(text));
check('blank is the default', parsed('  ') === JSON.stringify({ ok: true, value: null }), parsed('  '));
check('a whole number', parsed(' 25 ') === JSON.stringify({ ok: true, value: 25 }), parsed(' 25 '));
check('zero is allowed', parsed('0') === JSON.stringify({ ok: true, value: 0 }), parsed('0'));
check('the maximum', parsed('1000') === JSON.stringify({ ok: true, value: 1000 }), parsed('1000'));
for (const bad of ['1001', '-1', '10.5', '1e3', 'ten', '0x10']) {
  check(`refuses ${JSON.stringify(bad)}`, parseProjectLimitInput(bad).ok === false, parsed(bad));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
