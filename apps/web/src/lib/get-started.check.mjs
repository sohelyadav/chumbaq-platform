/**
 * Checks for `get-started.ts`. Same reasoning as `segment-form.check.mjs`: `apps/web`
 * has no test runner, and a checklist that calls a step done when it is not fails
 * silently.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const {
  getStartedSteps,
  nextStep,
  doneCount,
  allDone,
  showGetStarted,
  dismissedKey,
  sdkSnippets,
  sdkBaseUrl,
  usableBySdk,
  SDK_PLATFORMS,
  API_KEY_PLACEHOLDER,
  SDK_MIN_VERSION,
} = await jiti.import(path.join(here, 'get-started.ts'));

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

const NOTHING_KNOWN = { apiKeys: null, devices: null, pushChannels: null, pushDevices: null, campaigns: null };
const NEW_PROJECT = { apiKeys: 0, devices: 0, pushChannels: 0, pushDevices: 0, campaigns: 0 };
const done = (facts) => Object.fromEntries(getStartedSteps(facts).map((step) => [step.id, step.done]));

console.log('getStartedSteps');
{
  const steps = getStartedSteps(NEW_PROJECT);
  check('lists the five steps in order', steps.map((s) => s.id).join() === 'key,sdk,credentials,device,campaign');
  check('a new project has nothing done', steps.every((s) => s.done === false), JSON.stringify(steps));
  check('and starts at the API key', nextStep(steps) === 'key');
  check('with none counted', doneCount(steps) === 0);
}
{
  const d = done(NOTHING_KNOWN);
  check('nothing known is not the same as nothing done', Object.values(d).every((v) => v === null), JSON.stringify(d));
  check('nothing known keeps the card up', showGetStarted(getStartedSteps(NOTHING_KNOWN), false) === true);
  check('nothing known counts no step as done', doneCount(getStartedSteps(NOTHING_KNOWN)) === 0);
}
{
  const d = done({ ...NEW_PROJECT, apiKeys: 1 });
  check('a key alone finishes only the key step', d.key === true && d.sdk === false && d.device === false);
  check('and moves on to the SDK', nextStep(getStartedSteps({ ...NEW_PROJECT, apiKeys: 1 })) === 'sdk');
}
{
  // A member cannot list API keys, so that count never arrives for them.
  const member = { ...NEW_PROJECT, apiKeys: null };
  check('a role that cannot see keys leaves the key step unknown', done(member).key === null);
  check('a device proves a key exists, for a role that cannot see keys', done({ ...member, devices: 3 }).key === true);
  check('so does a device with a push token', done({ ...member, pushDevices: 1 }).key === true);
  check('but zero keys seen stays not done whatever else is true', done({ ...NEW_PROJECT, devices: 3 }).key === false);
}
{
  check('a device with a push token is a device, even when the device count is missing',
    done({ ...NEW_PROJECT, devices: null, pushDevices: 2 }).sdk === true);
  check('no device and an unknown push count leaves the SDK step not done',
    done({ ...NEW_PROJECT, devices: 0, pushDevices: null }).sdk === false);
  check('a device without a token does not finish the device step',
    done({ ...NEW_PROJECT, apiKeys: 1, devices: 5 }).device === false);
  check('credentials are their own step', done({ ...NEW_PROJECT, pushChannels: 1 }).credentials === true);
}
{
  const finished = { apiKeys: 1, devices: 4, pushChannels: 2, pushDevices: 3, campaigns: 1 };
  const steps = getStartedSteps(finished);
  check('everything done is all done', allDone(steps) === true && doneCount(steps) === 5 && nextStep(steps) === null);
  check('and hides the card', showGetStarted(steps, false) === false);
  const oneUnknown = getStartedSteps({ ...finished, campaigns: null });
  check('one unknown step is not all done', allDone(oneUnknown) === false && nextStep(oneUnknown) === 'campaign');
  check('and keeps the card up', showGetStarted(oneUnknown, false) === true);
  const oneLeft = getStartedSteps({ ...finished, campaigns: 0 });
  check('one step left keeps the card up', showGetStarted(oneLeft, false) === true);
  check('hiding it wins while steps remain', showGetStarted(oneLeft, true) === false);
}
check('the hidden note is kept per project', dismissedKey('p1') !== dismissedKey('p2') && dismissedKey('p1').includes('p1'));

console.log('usableBySdk');
{
  const NOW = Date.parse('2026-11-17T00:00:00Z');
  const key = (over = {}) => ({ isActive: true, expiresAt: null, permissions: ['read', 'write'], ...over });
  check('a live key with no expiry counts', usableBySdk(key(), NOW) === true);
  check('a revoked key does not', usableBySdk(key({ isActive: false }), NOW) === false);
  check('a privacy key does not: the API refuses it on every SDK route', usableBySdk(key({ permissions: ['privacy'] }), NOW) === false);
  check('an expired key does not', usableBySdk(key({ expiresAt: '2026-11-16T00:00:00Z' }), NOW) === false);
  check('a key that expires later does', usableBySdk(key({ expiresAt: '2026-12-01T00:00:00Z' }), NOW) === true);
}

console.log('sdkSnippets');
const VALUES = { baseUrl: 'https://app.example.com', projectId: '4fcba06f-27f6-463a-80b8-a6ee25d738fb' };
for (const platform of SDK_PLATFORMS) {
  const s = sdkSnippets(platform, VALUES);
  check(`${platform}: every part is there`, [s.installWhere, s.install, s.init, s.push, s.pushNote].every((part) => part.trim() !== ''));
  check(`${platform}: the init carries this project's id and host`, s.init.includes(VALUES.projectId) && s.init.includes(VALUES.baseUrl));
  check(`${platform}: no key given means a placeholder, never a blank`, s.init.includes(API_KEY_PLACEHOLDER));
  check(`${platform}: a key just made is filled in`,
    sdkSnippets(platform, { ...VALUES, apiKey: 'ck_live_abc123' }).init.includes('ck_live_abc123'));
}
{
  const flutter = sdkSnippets('flutter', VALUES);
  check('Flutter says the iOS token must be passed on by the app',
    flutter.push.includes('registerToken(hex)') && flutter.push.includes('didRegisterForRemoteNotificationsWithDeviceToken'));
}
for (const platform of ['android', 'flutter']) {
  const s = sdkSnippets(platform, VALUES);
  check(`${platform}: says the app must be set up with Firebase`,
    !!s.setupNote && s.setupNote.includes('google-services.json') && s.setupNote.includes('com.google.gms.google-services')
      && s.pushNote.includes('Firebase'));
}
check('iOS and web have no Firebase app setup line', !sdkSnippets('ios', VALUES).setupNote && !sdkSnippets('web', VALUES).setupNote);
check('the iOS package asks for the minimum SDK version', sdkSnippets('ios', VALUES).install.includes(`from: "${SDK_MIN_VERSION}"`));
check('the Android BOM asks for the minimum SDK version', sdkSnippets('android', VALUES).install.includes(`chumbaq-bom:${SDK_MIN_VERSION}"`));
check('a trailing slash on the origin is dropped', sdkBaseUrl('https://app.example.com/') === 'https://app.example.com');
check('a localhost origin with a port survives', sdkSnippets('web', { ...VALUES, baseUrl: 'https://localhost:5173' }).init.includes("'https://localhost:5173'"));
{
  // Nothing typed by anyone reaches these today, but the snippet is code someone runs.
  const hostile = sdkSnippets('web', { baseUrl: "https://x.test'; fetch('//evil')//", projectId: 'p"; drop', apiKey: "k'+alert(1)+'" });
  check('a value with a quote is never pasted into a snippet',
    !hostile.init.includes('evil') && !hostile.init.includes('drop') && !hostile.init.includes('alert'), hostile.init);
  check('and the snippet falls back to placeholders', hostile.init.includes('https://your-chumbaq-host') && hostile.init.includes(API_KEY_PLACEHOLDER));
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
