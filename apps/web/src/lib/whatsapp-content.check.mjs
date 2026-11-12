/**
 * Checks for `whatsapp-content.ts`, the composer's template helpers. Run with
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });

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

const { fromTemplate, contentProblem, fillPreview } = await jiti.import(path.join(here, 'whatsapp-content.ts'));

const template = {
  id: 'promo', name: 'promo', language: 'en', category: 'MARKETING', status: 'APPROVED',
  bodyText: 'Hi {{1}}, {{2}} off', bodyParamCount: 2, paramNames: null,
  header: { format: 'IMAGE', text: null, paramCount: 0 },
  buttons: [{ type: 'URL', text: 'Shop', dynamic: true }, { type: 'QUICK_REPLY', text: 'Stop', dynamic: false }],
};

const fresh = fromTemplate(template);
check('one empty value per placeholder', fresh.bodyParams.length === 2 && fresh.bodyParams.every((v) => v === ''));
check('one value per dynamic button only', fresh.buttonParams.length === 1);
check('a media header asks for its URL and type', fresh.headerMediaUrl === '' && fresh.headerMediaType === 'image');
check('fresh content is not sendable yet', contentProblem(fresh, template) === 'Fill in every value.');

const filled = { ...fresh, bodyParams: ['Priya', '20%'], headerMediaUrl: 'https://cdn/x.png', buttonParams: ['sale'] };
check('filled content is sendable', contentProblem(filled, template) === null);
check('an http media URL is refused', /https URL/.test(contentProblem({ ...filled, headerMediaUrl: 'http://cdn/x.png' }, template) ?? ''));
check('a hand-entered template needs only a name, language and values',
  contentProblem({ template: { id: 'order_update', name: 'order_update', language: 'en' }, bodyParams: ['x'] }, undefined) === null);
check('a bad language code is refused',
  contentProblem({ template: { id: 't', name: 't', language: 'english' }, bodyParams: [] }, undefined) !== null);

check('preview fills numbered placeholders', fillPreview('Hi {{1}}, {{2}} off', ['Priya']) === 'Hi Priya, {{2}} off');
check('preview fills named placeholders', fillPreview('Hi {{first_name}}', ['Priya'], ['first_name']) === 'Hi Priya');

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
