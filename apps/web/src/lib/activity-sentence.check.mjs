/**
 * Checks for `activity-sentence.ts`: the plain sentence the Activity page shows for each
 * log entry. Every action in the shared `ACTIVITY_ACTION_GROUP` must have its own
 * sentence, so an action added to the union without one fails here rather than showing
 * "did member.invited" to a customer. Same reasoning as `segment-form.check.mjs`:
 * `apps/web` has no test runner.
 *
 *     npm run test:logic -w @chumbaq/web
 */
import { createJiti } from 'jiti';
import path from 'path';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { ACTIVITY_ACTION_GROUP } = await jiti.import('@chumbaq/shared');
const { activitySentence, activityQueryParams, readActivityFilters, kindOptions } = await jiti.import(
  path.join(here, 'activity-sentence.ts'),
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

const PRIYA = 'Priya (priya@acme.com)';

/** An entry as the API returns it, with only what a case needs set. */
function entry(action, over = {}) {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    occurredAt: '2026-11-09T10:00:00.000Z',
    actorKind: 'user',
    actorUserId: '00000000-0000-4000-8000-0000000000aa',
    actorLabel: PRIYA,
    action,
    group: ACTIVITY_ACTION_GROUP[action] ?? 'project',
    targetType: null,
    targetId: null,
    targetLabel: null,
    details: null,
    ipAddress: null,
    country: null,
    userAgent: null,
    ...over,
  };
}

/**
 * One case per action, shaped like what the API writes (the targets and `details` keys
 * of `ACTIVITY_DETAIL_KEYS`). Labels are null wherever the API stores none.
 */
const CASES = {
  'member.invited': [
    entry('member.invited', { targetLabel: 'sam@acme.com', details: { role: 'admin', email: 'sam@acme.com' } }),
    `${PRIYA} invited sam@acme.com as an admin`,
  ],
  'invite.resent': [entry('invite.resent', { targetLabel: 'sam@acme.com' }), `${PRIYA} resent the invite to sam@acme.com`],
  'invite.cancelled': [
    entry('invite.cancelled', { targetLabel: 'sam@acme.com' }),
    `${PRIYA} cancelled the invite to sam@acme.com`,
  ],
  'invite.accepted': [entry('invite.accepted', { targetLabel: 'priya@acme.com' }), `${PRIYA} accepted an invite and joined the project`],
  'member.role_changed': [
    entry('member.role_changed', { targetLabel: 'Sam (sam@acme.com)', details: { from: 'member', to: 'admin' } }),
    `${PRIYA} changed the role of Sam (sam@acme.com) from member to admin`,
  ],
  'member.removed': [
    entry('member.removed', { targetLabel: 'Sam (sam@acme.com)' }),
    `${PRIYA} removed Sam (sam@acme.com) from the project`,
  ],
  'member.left': [entry('member.left', { targetLabel: PRIYA }), `${PRIYA} left the project`],
  'billing.transfer_offered': [
    entry('billing.transfer_offered', { targetLabel: 'Sam (sam@acme.com)', details: { toUserId: 'x' } }),
    `${PRIYA} offered billing for this project to Sam (sam@acme.com)`,
  ],
  'billing.transfer_accepted': [
    entry('billing.transfer_accepted', { targetLabel: PRIYA, details: { toUserId: 'x' } }),
    `${PRIYA} accepted billing for this project`,
  ],
  'billing.transfer_declined': [
    entry('billing.transfer_declined', { targetLabel: PRIYA, details: { toUserId: 'x' } }),
    `${PRIYA} declined billing for this project`,
  ],
  'billing.transfer_cancelled': [
    entry('billing.transfer_cancelled', { targetLabel: 'Sam (sam@acme.com)', details: { toUserId: 'x' } }),
    `${PRIYA} cancelled the billing offer to Sam (sam@acme.com)`,
  ],
  'project.renamed': [
    entry('project.renamed', { targetLabel: 'Acme', details: { from: 'Acme beta', to: 'Acme' } }),
    `${PRIYA} renamed the project from "Acme beta" to "Acme"`,
  ],
  'project.app_links_changed': [
    entry('project.app_links_changed', { targetLabel: 'Acme', details: { fields: ['iosBundleId'] } }),
    `${PRIYA} changed the project's app link settings`,
  ],
  'project.deleted': [entry('project.deleted', { targetLabel: 'Acme' }), `${PRIYA} deleted the project "Acme"`],
  'api_key.created': [
    entry('api_key.created', { targetLabel: 'Server', details: { name: 'Server', permissions: ['privacy'] } }),
    `${PRIYA} created the API key "Server"`,
  ],
  'api_key.revoked': [entry('api_key.revoked', { targetLabel: 'Server' }), `${PRIYA} revoked the API key "Server"`],
  'channel.settings_changed': [
    entry('channel.settings_changed', { targetLabel: 'Email', details: { channel: 'email', fields: ['fromName'] } }),
    `${PRIYA} changed the email settings`,
  ],
  'channel.provider_changed': [
    entry('channel.provider_changed', {
      targetLabel: 'Twilio',
      details: { channel: 'sms', fields: ['provider', 'credentials'] },
    }),
    `${PRIYA} switched the SMS provider to Twilio`,
  ],
  'channel.credentials_uploaded': [
    entry('channel.credentials_uploaded', { targetLabel: 'FCM', details: { channel: 'push', fields: ['credentials'] } }),
    `${PRIYA} updated the push credentials for FCM`,
  ],
  'email.ses_topic_reset': [
    entry('email.ses_topic_reset', { targetLabel: 'Email' }),
    `${PRIYA} cleared the Amazon SNS topic for email events`,
  ],
  'email.webhook_token_rotated': [
    entry('email.webhook_token_rotated', { targetLabel: 'Email' }),
    `${PRIYA} replaced the email event URLs`,
  ],
  'webhook.created': [
    entry('webhook.created', { targetLabel: 'w1', details: { events: ['click', 'conversion'] } }),
    `${PRIYA} added a webhook for click and conversion events`,
  ],
  'webhook.changed': [
    entry('webhook.changed', { targetLabel: 'w1', details: { events: ['click'], fields: ['url'] } }),
    `${PRIYA} changed a webhook`,
  ],
  'webhook.secret_rotated': [entry('webhook.secret_rotated', { targetLabel: 'w1' }), `${PRIYA} replaced a webhook's signing secret`],
  'webhook.deleted': [entry('webhook.deleted', { targetLabel: 'w1' }), `${PRIYA} deleted a webhook`],
  'mixpanel.configured': [entry('mixpanel.configured', { targetLabel: 'Mixpanel' }), `${PRIYA} changed the Mixpanel connection`],
  // The lead's ruling: a push audience is a count of devices; the other channels count people.
  'campaign.sent': [
    entry('campaign.sent', { targetLabel: 'Diwali sale', details: { channel: 'push', audienceSize: 12400 } }),
    `${PRIYA} sent the push campaign "Diwali sale" to 12,400 devices`,
  ],
  'campaign.scheduled': [
    entry('campaign.scheduled', { targetLabel: 'Weekly digest', details: { channel: 'email', audienceSize: 3200 } }),
    `${PRIYA} scheduled the email campaign "Weekly digest" for 3,200 people`,
  ],
  'campaign.cancelled': [
    entry('campaign.cancelled', { targetLabel: 'Reminder', details: { channel: 'whatsapp' } }),
    `${PRIYA} cancelled the WhatsApp campaign "Reminder"`,
  ],
  'push.sent_to_person': [entry('push.sent_to_person'), `${PRIYA} sent a push to one person`],
  'cohort.push_sent': [
    entry('cohort.push_sent', { targetLabel: 'Power users' }),
    `${PRIYA} sent a push to the Mixpanel cohort "Power users"`,
  ],
  'cohort.in_app_triggered': [
    entry('cohort.in_app_triggered', { targetLabel: 'Power users' }),
    `${PRIYA} showed an in-app message to the Mixpanel cohort "Power users"`,
  ],
  'in_app.triggered': [
    entry('in_app.triggered', { targetLabel: 'Welcome' }),
    `${PRIYA} triggered the in-app message "Welcome"`,
  ],
  'journey.status_changed': [
    entry('journey.status_changed', { targetLabel: 'Onboarding', details: { from: 'draft', to: 'active' } }),
    `${PRIYA} changed the journey "Onboarding" from draft to active`,
  ],
  'in_app_message.activated': [
    entry('in_app_message.activated', { targetLabel: 'Welcome' }),
    `${PRIYA} activated the in-app message "Welcome"`,
  ],
  'in_app_message.paused': [
    entry('in_app_message.paused', { targetLabel: 'Welcome' }),
    `${PRIYA} paused the in-app message "Welcome"`,
  ],
  'content.deleted': [
    entry('content.deleted', { targetLabel: 'Churn risk', targetType: 'segment', details: { kind: 'segment' } }),
    `${PRIYA} deleted the audience "Churn risk"`,
  ],
  'link.changed': [
    entry('link.changed', { targetLabel: 'Diwali', targetType: 'link', details: { fields: ['longUrl', 'isActive'] } }),
    `${PRIYA} changed the short link "Diwali" (destination, active)`,
  ],
  'person.erased': [entry('person.erased'), `${PRIYA} erased a person's data`],
  'person.exported': [entry('person.exported'), `${PRIYA} exported a person's data`],
  'person.consent_changed': [
    entry('person.consent_changed', { details: { consents: { emailOptIn: false, doNotTrack: true } } }),
    `${PRIYA} changed a person's consent: opted out of email, do not track on`,
  ],
  'tracking.objection_recorded': [
    entry('tracking.objection_recorded'),
    `${PRIYA} recorded a person's objection to tracking`,
  ],
  'tracking.objection_lifted': [entry('tracking.objection_lifted'), `${PRIYA} lifted a person's objection to tracking`],
  'suppression.added': [
    entry('suppression.added', { details: { channel: 'email', address: 'a***@example.com' } }),
    `${PRIYA} stopped email to a***@example.com`,
  ],
  'suppression.removed': [
    entry('suppression.removed', { details: { channel: 'sms', address: '+91******21' } }),
    `${PRIYA} allowed SMS to +91******21 again`,
  ],
  'activity.exported': [
    entry('activity.exported', { details: { filters: {}, rows: 1234 } }),
    `${PRIYA} downloaded the activity log (1,234 entries)`,
  ],
  'staff.viewed_as': [
    entry('staff.viewed_as', { actorKind: 'staff', actorUserId: null, actorLabel: 'Chumbaq support' }),
    'Chumbaq support viewed this project (read-only)',
  ],
};

console.log('activitySentence: one sentence per action');
const actions = Object.keys(ACTIVITY_ACTION_GROUP);
check(`every action in ACTIVITY_ACTION_GROUP has a case here (${actions.length})`, actions.every((a) => a in CASES),
  actions.filter((a) => !(a in CASES)).join(', '));
for (const action of actions) {
  const [e, want] = CASES[action] ?? [entry(action), '(no case)'];
  let got;
  try {
    got = activitySentence(e);
  } catch (err) {
    got = `threw ${err}`;
  }
  check(`${action}`, got === want, `want: ${want}\n          got:  ${got}`);
  // Never the fallback for a known action, whatever its labels.
  const bare = activitySentence(entry(action, { targetLabel: null, details: null }));
  check(`${action} with no label or details has its own sentence`, !bare.includes(` did ${action}`) && !bare.includes('null') && !bare.includes('undefined'), bare);
}

console.log('activitySentence: labels and counts');
check('the brief example, word for word bar the push noun',
  activitySentence(CASES['campaign.sent'][0]) === 'Priya (priya@acme.com) sent the push campaign "Diwali sale" to 12,400 devices');
check('no count when audienceSize is absent',
  activitySentence(entry('campaign.sent', { targetLabel: 'Diwali sale', details: { channel: 'push' } })) ===
    `${PRIYA} sent the push campaign "Diwali sale"`);
check('one device is singular',
  activitySentence(entry('campaign.sent', { targetLabel: 'X', details: { channel: 'push', audienceSize: 1 } })) ===
    `${PRIYA} sent the push campaign "X" to 1 device`);
check('one person is singular',
  activitySentence(entry('campaign.sent', { targetLabel: 'X', details: { channel: 'sms', audienceSize: 1 } })) ===
    `${PRIYA} sent the SMS campaign "X" to 1 person`);
check('zero is a count, not absent',
  activitySentence(entry('campaign.sent', { targetLabel: 'X', details: { channel: 'email', audienceSize: 0 } })) ===
    `${PRIYA} sent the email campaign "X" to 0 people`);
check('an unnamed campaign',
  activitySentence(entry('campaign.sent', { details: { channel: 'push', audienceSize: 5 } })) ===
    `${PRIYA} sent a push campaign to 5 devices`);
check('a deleted item with no name',
  activitySentence(entry('content.deleted', { details: { kind: 'banner_category' } })) === `${PRIYA} deleted a banner category`);
check('an unknown content kind',
  activitySentence(entry('content.deleted', { targetLabel: 'X', details: { kind: 'widget' } })) === `${PRIYA} deleted the item "X"`);
check('a variant added reads as added, with its fields',
  activitySentence(entry('link.changed', { targetLabel: 'Diwali', details: { change: 'added', fields: ['name', 'longUrl'], variant: 'B' } })) ===
    `${PRIYA} added the A/B variant "B" to the short link "Diwali" (name, destination)`);
check('a variant change names the variant and its fields',
  activitySentence(entry('link.changed', { targetLabel: 'Diwali', details: { change: 'changed', fields: ['longUrl', 'weight'], variant: 'B' } })) ===
    `${PRIYA} changed the A/B variant "B" of the short link "Diwali" (destination, weight)`);
check('a variant removal',
  activitySentence(entry('link.changed', { targetLabel: 'Diwali', details: { change: 'removed', variant: 'B' } })) ===
    `${PRIYA} removed the A/B variant "B" from the short link "Diwali"`);
check('add, change and remove read differently',
  new Set(['added', 'changed', 'removed'].map((change) =>
    activitySentence(entry('link.changed', { targetLabel: 'D', details: { change, fields: ['weight'], variant: 'B' } })))).size === 3);
check('a link change with no stored fields',
  activitySentence(entry('link.changed', { targetLabel: 'Diwali' })) === `${PRIYA} changed the short link "Diwali"`);
check('an unknown link field is shown by its name',
  activitySentence(entry('link.changed', { details: { fields: ['somethingNew'] } })) === `${PRIYA} changed a short link (somethingNew)`);
check('an invite with no role',
  activitySentence(entry('member.invited', { targetLabel: 'sam@acme.com' })) === `${PRIYA} invited sam@acme.com`);
check('an owner invite reads "an owner"',
  activitySentence(entry('member.invited', { targetLabel: 's@a.co', details: { role: 'owner' } })) === `${PRIYA} invited s@a.co as an owner`);
check('a member invite reads "a member"',
  activitySentence(entry('member.invited', { targetLabel: 's@a.co', details: { role: 'member' } })) === `${PRIYA} invited s@a.co as a member`);
check('one row downloaded is singular',
  activitySentence(entry('activity.exported', { details: { rows: 1 } })) === `${PRIYA} downloaded the activity log (1 entry)`);
check('an API key actor reads as stored',
  activitySentence(entry('person.erased', { actorKind: 'api_key', actorUserId: null, actorLabel: 'API key "Server"' })) ===
    'API key "Server" erased a person\'s data');
check('a staff entry ignores any label or details it carries',
  activitySentence(entry('staff.viewed_as', { actorKind: 'staff', actorLabel: 'Someone', targetLabel: 'x', details: { reason: 'r' } })) ===
    'Chumbaq support viewed this project (read-only)');
check('a staff actor on any action never shows a name',
  activitySentence(entry('project.renamed', { actorKind: 'staff', actorLabel: 'Ann (ann@chumbaq.com)' })) ===
    'Chumbaq support viewed this project (read-only)');
check('an unknown action falls back to "<actor> did <action>"',
  activitySentence(entry('widget.exploded')) === `${PRIYA} did widget.exploded`);
check('a non-number audience is ignored',
  activitySentence(entry('campaign.sent', { targetLabel: 'X', details: { channel: 'push', audienceSize: '9' } })) ===
    `${PRIYA} sent the push campaign "X"`);
check('a message moved off active by an edit says where it went',
  activitySentence(entry('in_app_message.paused', { targetLabel: 'X', details: { to: 'archived' } })) ===
    `${PRIYA} paused the in-app message "X" (now archived)`);
check('an unnamed message moved off active by an edit',
  activitySentence(entry('in_app_message.paused', { details: { to: 'draft' } })) === `${PRIYA} paused an in-app message (now draft)`);
check('a non-string pause destination is ignored',
  activitySentence(entry('in_app_message.paused', { targetLabel: 'X', details: { to: 3 } })) === `${PRIYA} paused the in-app message "X"`);
check('webhook events that are not a list are ignored',
  activitySentence(entry('webhook.created', { details: { events: 'click' } })) === `${PRIYA} added a webhook`);

console.log('filters in the URL');
const params = (q) => new URLSearchParams(q);
check('reads every filter', JSON.stringify(readActivityFilters(params('person=u1&group=team&from=2026-11-01&to=2026-11-09'), true)) ===
  JSON.stringify({ actor: 'u1', group: 'team', from: '2026-11-01', to: '2026-11-09' }));
check('an unknown group is dropped', readActivityFilters(params('group=nope'), true).group === undefined);
check('privacy is dropped without the privacy permission', readActivityFilters(params('group=privacy'), false).group === undefined);
check('privacy is kept with it', readActivityFilters(params('group=privacy'), true).group === 'privacy');
check('a malformed date is dropped', readActivityFilters(params('from=11/01/2026'), true).from === undefined);
check('query params leave out empty filters',
  JSON.stringify(activityQueryParams({ group: 'team' })) === JSON.stringify({ group: 'team' }));
check('query params name the person "actor" as the API wants',
  JSON.stringify(activityQueryParams({ actor: 'u1', from: '2026-11-01', to: '2026-11-02' })) ===
    JSON.stringify({ actor: 'u1', from: '2026-11-01', to: '2026-11-02' }));

console.log('kind choices');
const kinds = (mayPrivacy) => kindOptions(mayPrivacy).map((o) => o.value);
check('owners see Privacy', kinds(true).includes('privacy'));
check('admins do not', !kinds(false).includes('privacy'));
check('every other group is offered to admins', kinds(false).length === 7, JSON.stringify(kinds(false)));

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(1);
}
