import { randomUUID } from 'crypto';
import { expect, openSidebarGroup, signIn, sidebarLink, test } from '../../support/fixtures';
import { newClientIp } from '../../support/api';
import {
  call,
  checkMessages,
  createWidget,
  createWidgetItem,
  dataOf,
  deliveredIds,
  deliveredIdsWith,
  fingerprint,
  identifyDevice,
  identitySecret,
  impressionRows,
  inAppProject,
  messageIn,
  messageOf,
  messageRow,
  pendingRows,
  recordEvents,
  recordInAppEvent,
  recordRequests,
  sdkCall,
  sdkRequest,
  setMessageStatus,
  sql,
  teammate,
  traitSegment,
  triggerFor,
  userHash,
  waitForAllCounters,
  waitForCounters,
  widgetEventRows,
  widgetListRow,
  widgetRow,
  widgetRowStat,
  type InAppProject,
} from '../../support/areas/inapp';
import type { Page } from '@playwright/test';

/**
 * In-app messages (P1): the message analytics summary, the SDK's check route (body
 * validation, triggers, schedule windows, priority, user filters, segments, frequency
 * caps, the trigger queue) and event route (validation, what is stored and counted),
 * and the widgets list (sidebar, layouts, row content, the expanded row, Edit).
 */

test.describe.configure({ mode: 'parallel' });

const MESSAGES = (projectId: string) => `/api/projects/${projectId}/in-app-messages`;
const IOS = { platform: 'ios' };
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
/** The filled look of a selected range button. */
const FILLED = /(^|\s)bg-primary(\s|$)/;

/** A check whose body is sent as given, with the project's key. */
function rawCheck(p: InAppProject, body: unknown) {
  return sdkCall('/api/messages/check', p.sdkKey, body);
}

/** A widget (banner category) with `count` items, made through the API. */
async function widgetWith(
  p: InAppProject,
  name: string,
  layout: string,
  count: number,
  extra: Record<string, unknown> = {},
) {
  const widget = await createWidget(p.owner, p.project.id, { name, layout, ...extra });
  const items = [];
  for (let i = 0; i < count; i++) {
    items.push(
      await createWidgetItem(p.owner, widget.id, {
        title: `${name} item ${i + 1}`,
        imageUrl: `https://example.com/${encodeURIComponent(name)}-${i}.png`,
        clickUrl: `https://example.com/offer/${i}`,
        sortOrder: i,
      }),
    );
  }
  return { widget, items };
}

async function openWidgets(page: Page, projectId: string, type: string, heading: string): Promise<void> {
  await page.goto(`/projects/${projectId}/widgets/${type}`);
  await expect(page.getByRole('heading', { level: 1, name: heading, exact: true })).toBeVisible();
}

/** The expanded part of a widgets-list row (the row under it holding the footer). */
function expandedPart(page: Page, widgetId: string) {
  return page.getByRole('row').filter({ hasText: `Widget ID: ${widgetId}` });
}

// ------------------------------------------------------------ I. Message analytics API ---

test('INAPP-137 analytics summary fields', async () => {
  const p = await inAppProject('inapp-137');
  const member = await teammate(p.project.id, 'member', p.owner);
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Measured' });
  const [a, b, c] = [fingerprint('fp-137a'), fingerprint('fp-137b'), fingerprint('fp-137c')];
  await recordEvents(p, message.id, a, 'delivered', 2);
  await recordEvents(p, message.id, b, 'delivered', 2);
  await recordEvents(p, message.id, c, 'delivered', 1);
  await recordEvents(p, message.id, a, 'impression', 2);
  await recordEvents(p, message.id, b, 'impression', 1);
  await recordEvents(p, message.id, c, 'impression', 1);
  await recordEvents(p, message.id, a, 'click', 1);
  await recordEvents(p, message.id, b, 'cta_click', 1, 'start');
  await recordEvents(p, message.id, c, 'dismiss', 1);
  await recordEvents(p, message.id, a, 'auto_dismiss', 1);
  expect(await impressionRows(message.id)).toHaveLength(13);

  const response = await call('GET', `${MESSAGES(p.project.id)}/${message.id}/analytics`, member);
  expect(response.status).toBe(200);
  expect(dataOf(response)).toEqual({
    messageId: message.id,
    totalDelivered: 5,
    totalImpressions: 4,
    totalClicks: 1,
    totalCtaClicks: 1,
    totalDismissals: 1,
    totalAutoDismissals: 1,
    uniqueUsers: 3,
    clickRate: 0.5,
    dismissRate: 0.25,
  });
});

// ------------------------------------------------------------ J. SDK check ---

test('INAPP-147 check body validation', async () => {
  const p = await inAppProject('inapp-147');
  const projectId = p.project.id;
  const fp = fingerprint('fp-d1');

  const bare = await rawCheck(p, { projectId });
  expect(bare.status).toBe(400);
  expect([...bare.body.message].sort()).toEqual(['context must be an object', 'deviceFingerprint must be a string']);

  const noContext = await rawCheck(p, { projectId, deviceFingerprint: fp });
  expect(noContext.status).toBe(400);
  expect(noContext.body.message).toEqual(['context must be an object']);

  const stringContext = await rawCheck(p, { projectId, deviceFingerprint: fp, context: 'x' });
  expect(stringContext.status).toBe(400);
  expect(stringContext.body.message).toEqual(['context must be an object']);

  const extra = await rawCheck(p, { projectId, deviceFingerprint: fp, context: IOS, foo: 1 });
  expect(extra.status).toBe(400);
  expect(extra.body.message).toEqual(['property foo should not exist']);

  // Control: the same body without the extra key is answered.
  const good = await rawCheck(p, { projectId, deviceFingerprint: fp, context: IOS });
  expect(good.status).toBe(201);
  expect(dataOf(good)).toEqual({ messages: [] });
});

test('INAPP-150 unknown device still gets an all-users message', async () => {
  const p = await inAppProject('inapp-150');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Everyone' });
  const unknown = fingerprint('fp-unknown');

  expect(await deliveredIds(p, unknown)).toEqual([message.id]);
  // The device was never identified, and the check did not make it known.
  expect(await sql(`SELECT id FROM device_identities WHERE project_id = $1 AND device_fingerprint = $2`, [p.project.id, unknown])).toEqual([]);
});

test('INAPP-152 on-event matching', async () => {
  const p = await inAppProject('inapp-152');
  const message = await messageIn(p.owner, p.project.id, 'active', { triggerType: 'on_event', triggerEvent: 'checkout' });
  const fp = fingerprint('fp-152');

  expect(await deliveredIdsWith(p, fp, { ...IOS, event: 'checkout' })).toEqual([message.id]);
  expect(await deliveredIdsWith(p, fp, { ...IOS, event: 'Checkout' })).toEqual([]);
  expect(await deliveredIdsWith(p, fp, { ...IOS, event: 'checkout_done' })).toEqual([]);
  expect(await deliveredIdsWith(p, fp, IOS)).toEqual([]);
});

test('INAPP-153 on-screen matching', async () => {
  const p = await inAppProject('inapp-153');
  const message = await messageIn(p.owner, p.project.id, 'active', { triggerType: 'on_screen', triggerScreen: 'home' });
  const fp = fingerprint('fp-153');

  expect(await deliveredIdsWith(p, fp, { ...IOS, screen: 'home' })).toEqual([message.id]);
  expect(await deliveredIdsWith(p, fp, { ...IOS, screen: 'settings' })).toEqual([]);
  expect(await deliveredIdsWith(p, fp, IOS)).toEqual([]);
});

test('INAPP-154 immediate messages are never served by check', async () => {
  const p = await inAppProject('inapp-154');
  const immediate = await messageIn(p.owner, p.project.id, 'active', { name: 'Right now', triggerType: 'immediate', priority: 9 });
  // Control: an app-open message of the same project is delivered by the same checks.
  const appOpen = await messageIn(p.owner, p.project.id, 'active', { name: 'On open', priority: 1 });
  const fp = fingerprint('fp-154');

  for (const context of [IOS, { platform: 'android', event: 'checkout' }, { platform: 'web', screen: 'home', appVersion: '2.0.0' }]) {
    expect(await deliveredIdsWith(p, fp, context), JSON.stringify(context)).toEqual([appOpen.id]);
  }
  expect((await messageRow(immediate.id))?.status).toBe('active');
});

test('INAPP-155 scheduled trigger inside and outside its window', async () => {
  const p = await inAppProject('inapp-155');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Timed', triggerType: 'scheduled' });
  const fp = fingerprint('fp-155');
  const patch = async (body: Record<string, unknown>) =>
    dataOf(await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, body));

  // 4. No dates: delivered.
  expect(await deliveredIds(p, fp)).toEqual([message.id]);
  // 1. Inside its window.
  await patch({ startsAt: iso(-HOUR), endsAt: iso(HOUR) });
  expect(await deliveredIds(p, fp)).toEqual([message.id]);
  // 2. Starting in an hour.
  await patch({ startsAt: iso(HOUR), endsAt: iso(2 * HOUR) });
  expect(await deliveredIds(p, fp)).toEqual([]);
  // 3. Ended a minute ago.
  await patch({ startsAt: iso(-2 * HOUR), endsAt: iso(-MINUTE) });
  expect(await deliveredIds(p, fp)).toEqual([]);
  expect((await messageRow(message.id))?.status).toBe('active');
});

test('INAPP-156 schedule window applies to every trigger type', async () => {
  const p = await inAppProject('inapp-156');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Tomorrow', startsAt: iso(24 * HOUR) });
  const fp = fingerprint('fp-156');

  expect(await deliveredIds(p, fp)).toEqual([]);
  dataOf(await call('PATCH', `${MESSAGES(p.project.id)}/${message.id}`, p.owner, { startsAt: iso(-MINUTE) }));
  expect(await deliveredIds(p, fp)).toEqual([message.id]);
});

test('INAPP-157 priority order and at most three messages', async () => {
  const p = await inAppProject('inapp-157');
  const byPriority = new Map<string, number>();
  for (const priority of [1, 5, 3, 9, 0]) {
    const message = await messageIn(p.owner, p.project.id, 'active', { name: `Priority ${priority}`, priority });
    byPriority.set(message.id, priority);
  }

  const ids = await deliveredIds(p, fingerprint('fp-157'));
  expect(ids.map((id) => byPriority.get(id))).toEqual([9, 5, 3]);
});

test('INAPP-159 user filters: platform, country, app version', async () => {
  const p = await inAppProject('inapp-159');
  const message = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Indian iOS 2.0',
    userFilters: { platforms: ['ios'], countries: ['IN'], appVersions: ['2.0.0'] },
  });
  const fp = fingerprint('fp-159');
  const all = { platform: 'ios', country: 'IN', appVersion: '2.0.0' };

  expect(await deliveredIdsWith(p, fp, all)).toEqual([message.id]);
  for (const changed of [{ platform: 'android' }, { country: 'US' }, { appVersion: '1.9.0' }]) {
    expect(await deliveredIdsWith(p, fp, { ...all, ...changed }), JSON.stringify(changed)).toEqual([]);
  }
  expect(await deliveredIdsWith(p, fp, { platform: 'ios', appVersion: '2.0.0' })).toEqual([]);
});

test('INAPP-164 segment message with a deleted or foreign segment is withheld', async () => {
  const p = await inAppProject('inapp-164');
  const other = await inAppProject('inapp-164-other');
  const secret = await identitySecret(p);
  const externalUserId = `ext-4-${randomUUID().slice(0, 8)}`;
  const d4 = await identifyDevice(
    p,
    { externalUserId, distinctId: externalUserId, userHash: userHash(secret, externalUserId), traits: { plan: 'pro' } },
    'fp-d4',
  );
  const segmentId = await traitSegment(p.owner, p.project.id, 'plan', 'pro');
  const foreignSegmentId = await traitSegment(other.owner, other.project.id, 'plan', 'pro');
  const deleted = await messageIn(p.owner, p.project.id, 'active', { name: 'Own segment', userType: 'segment', segmentId, priority: 5 });
  const foreign = await messageIn(p.owner, p.project.id, 'active', {
    name: 'Foreign segment',
    userType: 'segment',
    segmentId: foreignSegmentId,
    priority: 4,
  });
  const everyone = await messageIn(p.owner, p.project.id, 'active', { name: 'Everyone', priority: 1 });
  expect((await messageRow(foreign.id))?.segment_id).toBe(foreignSegmentId);

  // Control: while its segment exists, the own-segment message reaches d4.
  expect(await deliveredIds(p, d4.fingerprint)).toEqual([deleted.id, everyone.id]);

  dataOf(await call('DELETE', `/api/projects/${p.project.id}/segments/${segmentId}`, p.owner));
  const result = await checkMessages(p, d4.fingerprint);
  expect(result.status).toBe(201);
  expect(dataOf(result).messages.map((m: { id: string }) => m.id)).toEqual([everyone.id]);
});

test('INAPP-165 max shows per user counts impressions and deliveries', async () => {
  const p = await inAppProject('inapp-165');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Twice', maxImpressionsPerUser: 2 });
  const d5 = fingerprint('fp-d5');
  const d1 = fingerprint('fp-d1');

  await recordEvents(p, message.id, d5, 'impression', 1);
  expect(await deliveredIds(p, d5)).toEqual([message.id]);
  await recordEvents(p, message.id, d5, 'impression', 1);
  expect(await deliveredIds(p, d5)).toEqual([]);

  // One showing reported as delivered and as an impression uses the whole cap.
  expect(await deliveredIds(p, d1)).toEqual([message.id]);
  await recordEvents(p, message.id, d1, 'delivered', 1);
  await recordEvents(p, message.id, d1, 'impression', 1);
  expect(await deliveredIds(p, d1)).toEqual([]);
});

test('INAPP-166 minimum interval between shows', async () => {
  const p = await inAppProject('inapp-166');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Every ten minutes', minIntervalSeconds: 600 });
  const d5 = fingerprint('fp-d5');

  expect(await deliveredIds(p, d5)).toEqual([message.id]);
  await recordEvents(p, message.id, d5, 'impression', 1);
  expect(await deliveredIds(p, d5)).toEqual([]);

  const [row] = await impressionRows(message.id);
  await sql(`UPDATE in_app_message_impressions SET created_at = created_at - interval '11 minutes' WHERE id = $1`, [row.id]);
  expect(await deliveredIds(p, d5)).toEqual([message.id]);
});

test('INAPP-167 total impressions cap', async () => {
  test.info().annotations.push({ type: 'issue', description: 'INAPP-167' });
  test.fail();
  const p = await inAppProject('inapp-167');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Two in all', maxImpressionsTotal: 2 });
  const [d1, d2, d5] = [fingerprint('fp-d1'), fingerprint('fp-d2'), fingerprint('fp-d5')];

  await recordEvents(p, message.id, d1, 'impression', 1);
  await waitForCounters(message.id, 1, 0);
  // Control: below the total, a device already shown it still gets it.
  expect(await deliveredIds(p, d1)).toEqual([message.id]);

  await recordEvents(p, message.id, d2, 'impression', 1);
  await waitForCounters(message.id, 2, 0);
  expect(await deliveredIds(p, d1)).toEqual([]);
  expect(await deliveredIds(p, d5)).toEqual([]);
});

test('INAPP-169 an impression or delivered event marks the queued message delivered', async () => {
  const p = await inAppProject('inapp-169');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Queued', triggerType: 'immediate' });
  const [d1, d2, d3] = [fingerprint('fp-d1'), fingerprint('fp-d2'), fingerprint('fp-d3')];
  expect(await triggerFor(p.owner, p.project.id, message.id, [d1, d2, d3])).toBe(3);
  const statusOf = async (fp: string) => (await pendingRows(message.id)).find((r) => r.device_fingerprint === fp)?.status;

  // A click or a dismiss alone leaves it queued.
  await recordEvents(p, message.id, d1, 'click', 1);
  await recordEvents(p, message.id, d3, 'dismiss', 1);
  expect(await statusOf(d1)).toBe('pending');
  expect(await statusOf(d3)).toBe('pending');
  expect(await deliveredIds(p, d1)).toEqual([message.id]);
  expect(await deliveredIds(p, d3)).toEqual([message.id]);

  await recordEvents(p, message.id, d1, 'impression', 1);
  expect(await statusOf(d1)).toBe('delivered');
  expect(await deliveredIds(p, d1)).toEqual([]);

  await recordEvents(p, message.id, d2, 'delivered', 1);
  expect(await statusOf(d2)).toBe('delivered');
  expect(await deliveredIds(p, d2)).toEqual([]);

  expect(await statusOf(d3)).toBe('pending');
});

test('INAPP-170 queued messages expire after 24 hours', async () => {
  const p = await inAppProject('inapp-170');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Queued', triggerType: 'immediate' });
  const d1 = fingerprint('fp-d1');
  await triggerFor(p.owner, p.project.id, message.id, [d1]);
  const [row] = await pendingRows(message.id);
  expect(row.status).toBe('pending');
  // Queued for a day.
  expect(Math.abs(new Date(row.expires_at).getTime() - (Date.now() + 24 * HOUR))).toBeLessThan(5 * MINUTE);
  expect(await deliveredIds(p, d1)).toEqual([message.id]);

  await sql(`UPDATE pending_in_app_messages SET expires_at = expires_at - interval '25 hours' WHERE id = $1`, [row.id]);
  expect(await deliveredIds(p, d1)).toEqual([]);
  await expect.poll(async () => (await pendingRows(message.id))[0]?.status).toBe('expired');
});

// ------------------------------------------------------------ J. SDK events ---

test('INAPP-175 event body validation', async () => {
  const p = await inAppProject('inapp-175');
  const message = await messageIn(p.owner, p.project.id, 'active');
  const base = { projectId: p.project.id, messageId: message.id, deviceFingerprint: fingerprint('fp-175'), eventType: 'impression' };
  const refused = async (body: Record<string, unknown>, expected: string) => {
    const result = await sdkCall('/api/messages/event', p.sdkKey, body);
    expect(result.status, expected).toBe(400);
    expect(result.body.message, expected).toEqual([expected]);
  };

  await refused({ ...base, messageId: 'x' }, 'messageId must be a UUID');
  await refused(
    { ...base, eventType: 'sent' },
    'eventType must be one of the following values: delivered, impression, click, dismiss, cta_click, auto_dismiss, expired',
  );
  await refused({ ...base, deviceFingerprint: 'f'.repeat(256) }, 'deviceFingerprint must be shorter than or equal to 255 characters');
  await refused({ ...base, distinctId: 'd'.repeat(513) }, 'distinctId must be shorter than or equal to 512 characters');
  await refused({ ...base, buttonId: 'b'.repeat(101) }, 'buttonId must be shorter than or equal to 100 characters');
  const { projectId: _omitted, ...noProject } = base;
  await refused(noProject, 'projectId must be a string');
  expect(await impressionRows(message.id)).toHaveLength(0);

  // Control: every field at its longest is accepted.
  const longest = await sdkCall('/api/messages/event', p.sdkKey, {
    ...base,
    deviceFingerprint: 'f'.repeat(255),
    distinctId: 'd'.repeat(512),
    buttonId: 'b'.repeat(100),
  });
  expect(longest.status).toBe(201);
  expect(dataOf(longest)).toEqual({ recorded: true });
  expect(await impressionRows(message.id)).toHaveLength(1);
});

test('INAPP-177 every event type is stored; counters move for some', async () => {
  const p = await inAppProject('inapp-177');
  const d1 = await identifyDevice(p, { distinctId: 'user-42' }, 'fp-d1');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Every event' });
  const ip = newClientIp();
  const userAgent = 'ChumbaqSDK/0.2.0 (iPhone; iOS 17.4) E2E';
  const types = ['delivered', 'impression', 'click', 'cta_click', 'dismiss', 'auto_dismiss', 'expired'];

  for (const eventType of types) {
    const result = await sdkRequest('POST', '/api/messages/event', {
      apiKey: p.sdkKey,
      ip,
      userAgent,
      body: {
        projectId: p.project.id,
        messageId: message.id,
        deviceFingerprint: d1.fingerprint,
        distinctId: 'user-42',
        eventType,
        ...(eventType === 'cta_click' ? { buttonId: 'start' } : {}),
      },
    });
    expect(result.status, eventType).toBe(201);
    expect(result.body.data, eventType).toEqual({ recorded: true });
  }

  const rows = await impressionRows(message.id);
  expect(rows.map((r) => r.event_type).sort()).toEqual([...types].sort());
  for (const row of rows) {
    expect(row, row.event_type).toMatchObject({
      project_id: p.project.id,
      device_identity_id: d1.id,
      distinct_id: 'user-42',
      device_fingerprint: d1.fingerprint,
      ip_address: ip,
      user_agent: userAgent,
      button_id: row.event_type === 'cta_click' ? 'start' : null,
    });
  }
  await waitForAllCounters(message.id, 1, 2, 1);
});

test('INAPP-178 events for a paused or archived message are still accepted', async () => {
  const p = await inAppProject('inapp-178');
  const message = await messageIn(p.owner, p.project.id, 'active', { name: 'Shown then stopped' });
  const fp = fingerprint('fp-178');
  await recordEvents(p, message.id, fp, 'impression', 1);
  await waitForAllCounters(message.id, 1, 0, 0);

  await setMessageStatus(p.owner, p.project.id, message.id, 'paused');
  const dismissed = await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: fp, eventType: 'dismiss' });
  expect(dismissed.status).toBe(201);
  expect(dataOf(dismissed)).toEqual({ recorded: true });
  await waitForAllCounters(message.id, 1, 0, 1);

  await setMessageStatus(p.owner, p.project.id, message.id, 'archived');
  const clicked = await recordInAppEvent(p, { messageId: message.id, deviceFingerprint: fp, eventType: 'click' });
  expect(clicked.status).toBe(201);
  expect(dataOf(clicked)).toEqual({ recorded: true });
  await waitForAllCounters(message.id, 1, 1, 1);

  expect((await impressionRows(message.id)).map((r) => r.event_type)).toEqual(['impression', 'dismiss', 'click']);
  expect((await messageRow(message.id))?.status).toBe('archived');
});

// ------------------------------------------------------------ K. Widgets list ---

test('INAPP-182 open each widget type from the sidebar', async ({ page }) => {
  const p = await inAppProject('inapp-182');
  await signIn(page, p.owner);
  await page.goto(`/projects/${p.project.id}`);
  await openSidebarGroup(page, 'Widgets');

  for (const [link, path, description] of [
    ['Banners', 'banners', 'Full-width or section-width promotional images with CTA'],
    ['Carousels', 'carousels', 'Auto-rotating horizontal slider of multiple items'],
    ['Stories', 'stories', 'Sequential full-screen cards like Instagram stories'],
    ['Grids', 'grids', 'Multi-item grid layout for product tiles and recommendations'],
    ['Swipe Strips', 'swipe-strips', 'Horizontal scrollable strip of cards'],
  ] as const) {
    await sidebarLink(page, link).click();
    await expect(page, link).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/${path}$`));
    await expect(page.getByRole('heading', { level: 1, name: link, exact: true }), link).toBeVisible();
    await expect(page.getByText(description, { exact: true }), link).toBeVisible();
  }
});

test('INAPP-185 each list shows only its own layout', async ({ page }) => {
  const p = await inAppProject('inapp-185');
  const lists = [
    { type: 'banners', heading: 'Banners', layout: 'single' },
    { type: 'carousels', heading: 'Carousels', layout: 'carousel' },
    { type: 'stories', heading: 'Stories', layout: 'stories' },
    { type: 'grids', heading: 'Grids', layout: 'grid' },
    { type: 'swipe-strips', heading: 'Swipe Strips', layout: 'swipe_strip' },
  ];
  for (const { layout } of lists) await createWidget(p.owner, p.project.id, { name: `Layout ${layout}`, layout });

  await signIn(page, p.owner);
  const listPath = `/api/projects/${p.project.id}/banner-categories`;
  const categoryLists: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (request.method() === 'GET' && url.pathname === listPath) categoryLists.push(url.search);
  });
  for (const { type, heading, layout } of lists) {
    await openWidgets(page, p.project.id, type, heading);
    await expect(widgetListRow(page, `Layout ${layout}`), type).toBeVisible();
    // The header row and this layout's one row.
    await expect(page.getByRole('row'), type).toHaveCount(2);
    for (const otherLayout of lists.map((l) => l.layout).filter((l) => l !== layout)) {
      await expect(page.getByText(`Layout ${otherLayout}`, { exact: true }), `${type}: ${otherLayout}`).toHaveCount(0);
    }
  }
  // Every list reads all categories (no layout filter) and filters in the browser.
  expect(categoryLists.length).toBeGreaterThan(0);
  expect(categoryLists.every((search) => search === '')).toBe(true);
});

test('INAPP-186 row content', async ({ page }) => {
  test.info().annotations.push({ type: 'issue', description: 'INAPP-186' });
  test.fail();
  const p = await inAppProject('inapp-186');
  const { widget, items } = await widgetWith(p, 'Home hero', 'carousel', 3, { description: 'Top of home', status: 'active' });
  dataOf(await sdkRequest('GET', `/api/in-app-banners/serve/${widget.id}`, { apiKey: p.sdkKey }));
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(3);
  dataOf(await sdkRequest('POST', `/api/in-app-banners/${items[0].id}/click`, { apiKey: p.sdkKey }));
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(4);

  await signIn(page, p.owner);
  await openWidgets(page, p.project.id, 'carousels', 'Carousels');
  const row = widgetListRow(page, 'Home hero');
  const cells = row.getByRole('cell');
  await expect(row.locator('img')).toHaveAttribute('src', items[0].imageUrl);
  await expect(cells.nth(0).getByText('Top of home', { exact: true })).toBeVisible();
  await expect(cells.nth(1)).toHaveText('Active');
  await expect(cells.nth(2)).toHaveText('3 slides');
  const updated = (await widgetRow(widget.id))!.updated_at as Date;
  const localDate = await page.evaluate((at) => new Date(at).toLocaleDateString(), updated.toISOString());
  await expect(cells.nth(3)).toHaveText(localDate);
  // One serve and one click: 3 impressions (one per live slide) and 1 click.
  await expect(cells.nth(4)).toHaveText('3');
  await expect(cells.nth(5)).toHaveText('1');
});

test('INAPP-189 expand a row: stats, chart and footer', async ({ page }) => {
  const p = await inAppProject('inapp-189');
  const { widget, items } = await widgetWith(p, 'One slide', 'carousel', 1, { status: 'active' });
  const second = await createWidget(p.owner, p.project.id, { name: 'Another carousel', layout: 'carousel' });
  const [ipA, ipB] = [newClientIp(), newClientIp()];
  for (const ip of [ipA, ipA, ipA, ipB, ipB, ipB]) {
    dataOf(await sdkRequest('GET', `/api/in-app-banners/serve/${widget.id}`, { apiKey: p.sdkKey, ip }));
  }
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(6);
  for (const ip of [ipA, ipB]) {
    dataOf(await sdkRequest('POST', `/api/in-app-banners/${items[0].id}/click`, { apiKey: p.sdkKey, ip }));
  }
  await expect.poll(async () => (await widgetEventRows(widget.id)).length).toBe(8);

  await signIn(page, p.owner);
  const analytics = recordRequests(page, 'GET', new RegExp(`/api/banner-categories/${widget.id}/analytics(/timeseries)?$`));
  await openWidgets(page, p.project.id, 'carousels', 'Carousels');
  const row = widgetListRow(page, 'One slide');
  await expect(row.getByRole('cell').nth(4)).toHaveText('6');
  expect(analytics).toEqual([]);
  const chevron = row.getByRole('cell').last().locator('svg');
  await expect(chevron).not.toHaveClass(/rotate-180/);

  await row.click();
  const expanded = expandedPart(page, widget.id);
  await expect(expanded).toBeVisible();
  await expect(chevron).toHaveClass(/rotate-180/);
  await expect(widgetRowStat(expanded, 'Impressions')).toHaveText('6');
  await expect(widgetRowStat(expanded, 'Clicks')).toHaveText('2');
  await expect(widgetRowStat(expanded, 'CTR')).toHaveText('33.3%');
  await expect(widgetRowStat(expanded, 'Unique Visitors')).toHaveText('2');
  await expect(expanded.getByText('Performance', { exact: true })).toBeVisible();
  for (const label of ['7d', '30d', '90d', 'All time']) {
    const button = expanded.getByRole('button', { name: label, exact: true });
    await expect(button, label).toBeVisible();
    if (label === '30d') await expect(button).toHaveClass(FILLED);
    else await expect(button, label).not.toHaveClass(FILLED);
  }
  // Today's events draw bars.
  await expect(expanded.locator('.recharts-bar-rectangle').first()).toBeVisible();
  await expect(expanded.getByText('No data available for this period')).toHaveCount(0);
  await expect(expanded.getByText(`Widget ID: ${widget.id}`, { exact: true })).toBeVisible();
  for (const label of ['Copy ID', 'Edit', 'Delete']) {
    await expect(expanded.getByRole('button', { name: label, exact: true }), label).toBeVisible();
  }
  await expect.poll(() => analytics.some((path) => path.endsWith('/analytics'))).toBe(true);
  expect(analytics.some((path) => path.endsWith('/analytics/timeseries'))).toBe(true);

  // Clicking the row again collapses it.
  await row.click();
  await expect(expanded).toHaveCount(0);
  await expect(chevron).not.toHaveClass(/rotate-180/);

  // Expanding another row collapses the first.
  await row.click();
  await expect(expanded).toBeVisible();
  await widgetListRow(page, 'Another carousel').click();
  await expect(expandedPart(page, second.id)).toBeVisible();
  await expect(expanded).toHaveCount(0);
});

test('INAPP-193 Edit from a multi-item row opens the detail page', async ({ page }) => {
  const p = await inAppProject('inapp-193');
  const widgets = [
    { type: 'carousels', heading: 'Carousels', ...(await widgetWith(p, 'Edit carousel', 'carousel', 1)) },
    { type: 'grids', heading: 'Grids', ...(await widgetWith(p, 'Edit grid', 'grid', 1)) },
    { type: 'swipe-strips', heading: 'Swipe Strips', ...(await widgetWith(p, 'Edit strip', 'swipe_strip', 1)) },
  ];
  await signIn(page, p.owner);

  for (const { type, heading, widget } of widgets) {
    await openWidgets(page, p.project.id, type, heading);
    await widgetListRow(page, widget.name).click();
    await expandedPart(page, widget.id).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page, type).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/${type}/${widget.id}$`));
    await expect(page.getByRole('heading', { level: 1, name: widget.name, exact: true }), type).toBeVisible();
  }
});

test('INAPP-194 Edit from a banner or story row opens the editor', async ({ page }) => {
  const p = await inAppProject('inapp-194');
  const widgets = [
    { type: 'banners', heading: 'Banners', editor: 'Edit Banner', ...(await widgetWith(p, 'Edit banner', 'single', 1)) },
    { type: 'stories', heading: 'Stories', editor: 'Edit Story', ...(await widgetWith(p, 'Edit story', 'stories', 1)) },
  ];
  await signIn(page, p.owner);

  for (const { type, heading, editor, widget } of widgets) {
    await openWidgets(page, p.project.id, type, heading);
    await widgetListRow(page, widget.name).click();
    await expandedPart(page, widget.id).getByRole('button', { name: 'Edit', exact: true }).click();
    await expect(page, type).toHaveURL(new RegExp(`/projects/${p.project.id}/widgets/${type}/${widget.id}/edit$`));
    await expect(page.getByRole('heading', { level: 1, name: editor, exact: true }), type).toBeVisible();
  }
});
