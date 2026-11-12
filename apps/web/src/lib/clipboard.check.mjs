/**
 * Checks for `clipboard.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { copyText } = await jiti.import(path.join(here, 'clipboard.ts'));

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

console.log('copyText');
const written = [];
const writes = { writeText: async (text) => { written.push(text); } };
check('true when the write succeeds', (await copyText('s3cret', writes)) === true);
check('writes the text it was given', written[0] === 's3cret');

let refused;
try {
  refused = await copyText('s3cret', {
    writeText: async () => {
      throw new Error('NotAllowedError: Write permission denied.');
    },
  });
} catch (error) {
  refused = error;
}
check('false, not a rejection, when the write is refused', refused === false, String(refused));
check('false when there is no clipboard API', (await copyText('s3cret', null)) === false);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
