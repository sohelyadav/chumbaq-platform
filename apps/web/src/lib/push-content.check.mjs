/**
 * Checks for `pushContentCaveats` in `push-content.ts` — the platform notes
 * the push composer shows under the template gallery.
 *
 * ## Why this is a script and not a test suite
 *
 * The same reason as `segment-form.check.mjs`, which this follows: `apps/web`
 * has no test runner, installing vitest failed on this machine with an
 * `EACCES` in the npm cache, so the assertions live here and run with nothing
 * but node:
 *
 *     npm run test:logic -w @chumbaq/web
 *
 * ## Why these assertions and not others
 *
 * One of these notes is the only warning a campaign author will ever get
 * about something that is otherwise completely silent.
 *
 * A carousel or a countdown reaches iOS through a Notification Content
 * Extension, and iOS selects that extension by matching the notification's
 * `aps.category` against a `UNNotificationExtensionCategory` string compiled
 * into the host app. A campaign that sets no iOS category therefore has
 * nothing to match: iOS draws the plain notification, the carousel is
 * absent, and nothing anywhere reports a problem. The dashboard shows a sent
 * campaign, the API shows a successful send, the device shows a notification.
 *
 * It cannot be caught anywhere else, which is why it is pinned here:
 *
 * - The server cannot invent the string — only the host app defines it.
 * - The server cannot reject the campaign for lacking it either. Android
 *   builds its carousel from `RemoteViews` with no category involved, so an
 *   Android-only carousel is a legitimate campaign that must stay sendable.
 *
 * So it has to be a note rather than an error, and the composer is the last
 * place anyone sees it. The assertions below pin that the note appears when
 * it should, says what will actually happen rather than naming a missing
 * field, and stays out of the way when it does not apply.
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

const { pushContentCaveats } = await jiti.import(path.join(here, 'push-content.ts'));

/** An empty composer, which every case below varies one field of. */
function composed(overrides = {}) {
  return {
    silent: false,
    imageUrl: '',
    carouselSlides: 0,
    hasTimer: false,
    actions: 0,
    iosCategory: '',
    ...overrides,
  };
}

const mentionsCategory = (notes) =>
  notes.filter((note) => note.includes('UNNotificationExtensionCategory'));

// ── The carousel and countdown category note ──────────────────────────

console.log('a carousel or countdown with no iOS category is called out');

const carouselNoCategory = pushContentCaveats(composed({ carouselSlides: 3 }));
check(
  'a carousel with no iOS category warns',
  mentionsCategory(carouselNoCategory).length === 1,
  carouselNoCategory.join(' | '),
);
check(
  'it says what iOS recipients will actually see',
  mentionsCategory(carouselNoCategory)[0]?.includes('iOS recipients will see a plain notification without the carousel'),
  mentionsCategory(carouselNoCategory)[0],
);
check(
  'it says what to set, not just that a field is empty',
  mentionsCategory(carouselNoCategory)[0]?.includes('Set the iOS category'),
);

const timerNoCategory = pushContentCaveats(composed({ hasTimer: true }));
check(
  'a countdown with no iOS category warns',
  mentionsCategory(timerNoCategory).length === 1,
  timerNoCategory.join(' | '),
);
check(
  'and names the countdown rather than a carousel it has not got',
  mentionsCategory(timerNoCategory)[0]?.includes('without the countdown'),
  mentionsCategory(timerNoCategory)[0],
);

const both = pushContentCaveats(composed({ carouselSlides: 2, hasTimer: true }));
check('a campaign with both is warned once, not twice', mentionsCategory(both).length === 1, both.join(' | '));

// ── When it must stay quiet ───────────────────────────────────────────

console.log('\nand stays quiet when it does not apply');

check(
  'a carousel with an iOS category is not warned',
  mentionsCategory(pushContentCaveats(composed({ carouselSlides: 3, iosCategory: 'SHOP' }))).length === 0,
);
check(
  'whitespace is not a category',
  mentionsCategory(pushContentCaveats(composed({ carouselSlides: 3, iosCategory: '   ' }))).length === 1,
);
check(
  'a plain campaign with no category is not warned',
  mentionsCategory(pushContentCaveats(composed())).length === 0,
);
check(
  'an image-only campaign with no category is not warned',
  mentionsCategory(pushContentCaveats(composed({ imageUrl: 'https://cdn.test/a.png' }))).length === 0,
);
check(
  'buttons alone keep their own note and not this one',
  (() => {
    const notes = pushContentCaveats(composed({ actions: 2 }));
    return mentionsCategory(notes).length === 0
      && notes.some((note) => note.includes('buttons only from a category'));
  })(),
);

// A silent push displays nothing at all, so no rendering note applies —
// including this one.
const silent = pushContentCaveats(composed({ silent: true, carouselSlides: 3, hasTimer: true }));
check('a silent push says only that nothing is displayed', silent.length === 1, silent.join(' | '));
check('…and is not warned about a carousel it will not draw', mentionsCategory(silent).length === 0);

// ── The notes that were already there ─────────────────────────────────

console.log('\nthe existing platform notes still appear');

const carousel = pushContentCaveats(composed({ carouselSlides: 3, iosCategory: 'SHOP' }));
check('a carousel still notes the Android expanded view', carousel.some((n) => n.includes('expanded view')));
check('a carousel still notes the iOS content extension', carousel.some((n) => n.includes('Notification Content Extension')));
check('a carousel still notes Xiaomi showing no image', carousel.some((n) => n.includes('Xiaomi')));
check(
  'a countdown still notes the iOS content extension',
  pushContentCaveats(composed({ hasTimer: true, iosCategory: 'SALE' }))
    .some((n) => n.includes('countdown needs a Notification Content Extension')),
);
check(
  'an image still notes the iOS service extension',
  pushContentCaveats(composed({ imageUrl: 'https://cdn.test/a.png' }))
    .some((n) => n.includes('Notification Service Extension')),
);
check('nothing composed means nothing to warn about', pushContentCaveats(composed()).length === 0);

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exit(1);
