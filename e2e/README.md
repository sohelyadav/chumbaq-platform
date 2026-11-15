# End-to-end tests

Playwright tests that drive the customer app and the admin app in a real browser,
against the whole stack: the customer API, the admin API, the worker and both Vite dev
servers, on a database of their own.

## Running

```bash
npm run test:e2e                         # headless, every spec
npm run test:e2e:ui                      # Playwright's UI mode
npm run test:e2e -- tests/team.spec.ts   # one spec
npm run test:e2e -- tests/link/          # one area (every spec in the folder)
npm run test:e2e -- tests/link/ tests/ppl/   # several areas in one run
npm run test:e2e -- tests/link/link-p0-02.spec.ts:120   # one test, by file and line
npm run test:e2e -- -- tests/link --grep "LINK-161"     # by title: note the second --
E2E_SKIP_BUILD=1 npm run test:e2e        # skip rebuilding the API (when only specs or the web app changed)
```

The root script runs `npm run e2e --workspace=e2e`, so a single `--` hands file
arguments through but npm keeps flags such as `--grep` (and reads `-g` as its own
`--global`). Pass flags after a second `--`, use `file:line`, or run
`npm run e2e --workspace=e2e -- <args>` directly. File arguments are regular expressions
matched against the path, so end a folder with `/`: `tests/team` also picks up
`tests/team.spec.ts`.

The first time, install the browser: `npx playwright install chromium`.

### Lanes: several stacks at once

`E2E_LANE` picks one of three stacks, so several runs can go side by side from one
checkout. Unset or `0` is the stack the `.env` describes. Lane `n` (1 or 2) is derived
from it (`laneOverrides` in `support/stack.ts`):

- database `chumbaq_l<n>_e2e` (create it once:
  `psql -U postgres -c "CREATE DATABASE chumbaq_l1_e2e OWNER <DATABASE_USER>;"`);
- Redis database `12 + n`;
- every port moved up by `100 * n`: `API_PORT`, `ADMIN_API_PORT`, and the stack's ports
  wherever an address names one (`APP_URL`, `ADMIN_APP_URL`, `VITE_ADMIN_APP_URL`,
  `API_BASE_URL`, `CORS_ORIGINS`, ...), with the Razorpay mock and the provider stub
  following the API;
- artefacts under `e2e/.artefacts/lane-<n>/`.

The changes reach every process as environment variables, which win over the `.env`.
A lane refuses to start if it would share a database, a Redis database or a port with
lane 0. One run per lane at a time (the port check refuses a second), and build from one
lane only while nothing else runs: every lane runs the same `apps/api/dist`.

```bash
E2E_LANE=0 npm run test:e2e                     # builds, then runs
E2E_LANE=1 E2E_SKIP_BUILD=1 npm run test:e2e &  # meanwhile, elsewhere
E2E_LANE=2 E2E_SKIP_BUILD=1 npm run test:e2e
```

When several people or scripts share a machine, queue runs per lane instead of relying
on the port check, for example with macOS `lockf`:

```bash
lockf -k /tmp/chumbaq-e2e-lane-1.lock env E2E_LANE=1 E2E_SKIP_BUILD=1 npm run test:e2e -- tests/link/
```

The whole suite is quickest split by area folder across the three lanes, each lane
running its share with the default 3 workers. The split used for the full runs:

| Lane | Areas |
|---|---|
| 0 | `auth`, `bill`, `proj`, `smswa`, `integ`, `_helpers` and the top-level specs |
| 1 | `admauth`, `link`, `admten`, `email`, `admops`, `anly` |
| 2 | `team`, `ppl`, `acct`, `push`, `seg`, `inapp` |

On a recent laptop each lane takes 7 to 11 minutes, stack start included (lane 0 about
9.5, lane 1 about 7, lane 2 about 10.5), so the whole suite of 890 tests finishes in
about 11 minutes with the three lanes side by side, against roughly half an hour on one
lane. Build once from lane 0 first, then start the three with `E2E_SKIP_BUILD=1`.

Failures keep a trace and a screenshot under `e2e/.artefacts/test-results/` (open a
trace with `npx playwright show-trace <path>`); the HTML report is in
`e2e/.artefacts/report/`, and each process of the stack logs to `e2e/.artefacts/logs/`.
Lanes other than 0 use `e2e/.artefacts/lane-<n>/` instead.

### What it needs

Postgres and Redis running, and a repo-root `.env` (the one the apps read) set up for a
stack of its own:

- `DATABASE_NAME` ending in `_e2e`. **The harness drops and recreates its `public`
  schema on every run**, and refuses to start for any name that does not end in `_e2e`.
- `REDIS_DB` set to a database of its own (not 0). **It is flushed on every run.**
- `API_PORT`, `ADMIN_API_PORT`, `APP_URL` and `ADMIN_APP_URL` on ports nothing else
  uses. The Vite servers listen on the ports of `APP_URL` and `ADMIN_APP_URL`; the
  harness refuses to start if any of the ports is taken (another stack, or a run that
  died). `VITE_ADMIN_APP_URL` should equal `ADMIN_APP_URL`.
- `SUPER_ADMIN_PASSKEY_REQUIRED=false`, so a new super admin can enrol a passkey from a
  password alone (with it on, enrolment needs an operator's code, which the admin spec
  does not use).
- Everything else the API needs to boot (see `.env.example`).

### What the harness does (`support/global-setup.ts`)

1. Applies the lane's changes to the `.env` (none for lane 0), then checks the database
   name, the Redis database and the ports.
2. Builds `@chumbaq/shared` and the API.
3. Resets the database and Redis, and applies the migrations (some tables exist only in
   migrations, so `synchronize` alone would leave them out).
4. Starts a mock of Razorpay's API (`support/razorpay-mock.ts`) and the provider stub
   (`support/provider-stub.ts`, on the API port + 91), then the API with
   `NODE_ENV=test`, then the admin API, the worker and both Vite dev servers, waiting
   for each to answer. Everything is stopped when the run ends.

On top of the `.env`, the apps get per-run values: fresh JWT secrets, credentials key,
`MFA_ENCRYPTION_KEY` and `MIXPANEL_ENCRYPTION_KEY`, account email switched on against the provider stub (a fake `PLATFORM_BREVO_API_KEY`
and every provider's `*_API_BASE_URL` pointed at the stub, so nothing leaves the machine),
and billing switched on with obviously fake Razorpay keys, `BILLING_TAX_RATE_BPS=0` and
`RAZORPAY_API_BASE_URL` pointing at the mock. The API refuses `RAZORPAY_API_BASE_URL`
unless `NODE_ENV` is `development` or `test`, and the same goes for every
`*_API_BASE_URL` (`apps/api/src/config/provider-endpoints.config.ts`).

### Provider stub and mailbox

`support/provider-stub.ts` answers, in each provider's success shape, every outbound call
the apps make except Amazon's (SES, STS and SNS stay manual): account email's Brevo, and
the tenants' FCM (and Google's token exchange), Resend, Brevo, Twilio (and its Content
API), Meta, Gupshup, Interakt and Mixpanel. It records each call (credentials in headers
redacted); tests read them with `stubCalls(provider)`, make a provider fail with
`failStub(provider, { status | timeout, times?, match? })` and replace an answer with
`answerStub`. The stub is shared by the whole run, so filter calls, and scope failures
with `match`, by something the test owns (an address, an account id).

`support/mailbox.ts` reads account email back: `waitForMail(to, { subjectIncludes })`,
`latestMail`, `mailsTo`, `extractLink(mail, '/complete-signup')` (the whole link, token in
its `#token=` fragment) and `tokenFromLink`. `createAccount` signs up with the mailed link.

Every test makes its own accounts and projects with unique addresses, so specs do not
depend on each other or on order. Each test also sends its own `X-Forwarded-For` (the
API trusts it from a loopback peer, as it does behind nginx), so the per-address rate
limits on sign-up and sign-in treat every test as a separate client.

## The specs

### Walkthrough specs

One journey each, end to end, in `tests/` itself:

| Spec | Covers |
|---|---|
| `auth.spec.ts` | Sign up (form, then the sign-up link), sign out, the dashboard refusing a signed-out visitor, the wrong-password message, signing in, a reload keeping the session, and a used sign-up link being refused. |
| `projects-links.spec.ts` | Creating a first project and a short link with a custom code, opening it on the API's root redirect (`GET /<code>`, a 302 to the destination), and the link's dashboard counting the click (polled: clicks are recorded after the redirect answers). |
| `team.spec.ts` | An owner invites a member; the invite is mailed and its link also shown once; the teammate opens the mailed link signed out, signs in, and accepts; as a member they see no API keys, no invite form, no remove buttons and no activity log; the owner removes them and the project leaves their list. |
| `campaigns.spec.ts` | People arrive through the SDK's identify route; the owner saves the email sender (opt-in requirement off); the composer counts the audience (people opted out or with no address left out) and the campaign is scheduled a month ahead and listed as scheduled. |
| `billing.spec.ts` | Staff create a plan and price through the admin API (checked against the mock's plan); the customer sees it, gives billing details, "pays" in a stand-in for Razorpay Checkout, and becomes active only when the signed `subscription.activated` webhook arrives; cancels at the period end (and the mock receives the cycle-end cancel); then "Keep my plan" makes a successor that starts at the period end, authorised by a signed `subscription.authenticated`. |
| `_helpers/stubs.spec.ts` | The provider stub and mailbox: a sign-up mails a working `/complete-signup` link (and a second sign-up an "already registered" one); a Twilio connect and SMS test send reach the stub, and an injected 401 comes back as a failed test send. |
| `admin.spec.ts` | A super admin granted with `npm run admin:grant` enrols a passkey (Chromium's virtual authenticator) on `/enrol`, signs in with it, finds a tenant, starts view-as with a reason, follows the one-time link into the customer app, sees the read-only banner and the tenant's project, has a write refused, and exits back to the admin app. |


### Area specs

One folder per product area under `tests/<area>/`, split into files of 20 to 40 tests
(`<area>-p0-01.spec.ts`, ...). Each test is one case and its title starts with the case
id (`test('LINK-161 ...')`), so a failure names the case. They cover every P0 case of
each area that the local stack can run.

| Folder | Covers | Tests |
|---|---|---:|
| `auth` | Customer sign-up (two steps), sign-in and its failure limit, second factors at sign-in, passkeys and autofill, refresh tokens, sessions and their maximum length, password reset, verify email, staff-issued reset links and the cancel page, re-authentication | 81 |
| `acct` | Account settings: profile, password change, authenticator app and recovery codes, passkeys, sessions and sign-in history, pending factor resets, view-as refusals | 43 |
| `proj` | Project selector and create (project limit), dashboard, settings, domain proof, delete, read-only roles, suspension, view-as, cross-tenant refusals | 44 |
| `link` | Link create, edit, delete and bulk import, reserved and released short codes, redirects by platform, interstitial, deep links and deferred match, A/B variants, click export, `.well-known` files, do-not-track on clicks | 70 |
| `anly` | Project analytics, attribution models, touchpoints and events, roles and cross-project refusals, do-not-track and person objections in ingest | 28 |
| `ppl` | People list and profile, identify with `userHash`, device handover, consent edits and history, do-not-track, person objections, erasure and export (dashboard and privacy keys) | 51 |
| `seg` | Audience builder and segment API, materialised audiences, journeys (editor, activation, pause, enrolment from events and segments, waits), suspension | 48 |
| `push` | FCM configuration, Mi Push, push campaigns (send, schedule, cancel, recurrence, A/B arms), templates, guardrails and frequency cap, token register and unregister, opt-out | 42 |
| `email` | Email sender settings and provider connect, audience preview, test send, campaigns and their worker sends, double opt-in links, unsubscribe, Resend, Brevo and SES webhooks, suppressions | 45 |
| `smswa` | SMS (Twilio) and WhatsApp (Meta, Twilio, Gupshup, Interakt) settings, campaigns, test sends, signed and unsigned webhooks, STOP and START, suppressions, erasure | 62 |
| `inapp` | In-app message campaigns (editor, delivery rules, triggers, cohorts and segments, frequency cap) and widgets (categories, items, serve and click) | 47 |
| `team` | Members and roles, invitations (create, resend, revoke, accept), seats, billing transfer, activity log and its export | 79 |
| `integ` | API keys (including privacy keys), identity secret, outbound webhooks (create, rotate, address checks), Mixpanel cohorts | 37 |
| `bill` | Customer billing page, plans, Checkout, subscription changes and cancel, the Razorpay webhook, invoices, staff plans and prices, comps, the cancel outbox, billing summary, billing off | 52 |
| `admauth` | Admin app sign-in (passkey, password and second factor, enrolment codes), staff factors, staff sessions and refresh cookie, re-authentication, revocation | 58 |
| `admten` | Admin overview, tenants list and export, tenant page, usage, project and seat limits, suspension, view-as handoff and exchange, factor resets | 44 |
| `admops` | Audit log and its export, platform health, incidents, security alerts and the internal alert route, tripwires, security contact | 36 |

Totals: 867 tests in the area folders, plus 7 walkthrough tests and 16 in `_helpers`
(890 in all).

**Conventions.** Every test makes its own accounts, projects and client address, so the
files of a folder run side by side (several use `test.describe.configure({ mode:
'parallel' })`). Rows the UI cannot make, or that would take minutes to reach (an aged
sign-in, a back-dated click, a suspended account), are written with SQL through the
lane's database; everything else goes through the real routes. A test that checks for
the absence of something first shows a positive control (the same request with the
right input does land), so it cannot pass because nothing happens at all.

**Known defects.** A test marked `test.fail()` asserts the intended behaviour of a case
whose current behaviour is wrong. It counts as passing while the defect is there and goes
red when the defect is fixed, which is the signal to remove the marker. Each carries an
`issue` annotation with its case id. A few cases instead assert today's behaviour as the
case is written, with a comment saying so.

**Slow tests.** Some cases wait for real timers: the in-memory route throttles (about
61 s each, in `auth` and `admauth`), the worker's once-a-minute scheduler and outbox
(`bill`, `push`, `seg`, `smswa`, `email`), and fresh authenticator-app steps (up to 30 s).
They are marked `test.slow()` or set their own timeout. A new case that only needs a
worker job to have run can call `runJobNow` instead (see "Worker jobs on demand").

**Extra processes.** A few specs start a second API process on the lane's database for
one config variant, on a port derived from the lane's ports, and stop it when the
describe block ends: an admin API with `SUPER_ADMIN_PASSKEY_REQUIRED=true` or
`SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS` set (`admauth`), a customer and an admin API with
`BILLING_ENABLED=false` (`bill`), and an admin API with `SECURITY_ALERT_TOKEN` set
(`admops`). The page's requests are routed to it with `page.route`.

### Area helpers

`support/areas/<area>.ts` holds each area's helpers (one file per folder): raw requests
that return status and body without throwing, SQL readers and seeds (`withDb` / `sql`),
role and teammate setup, view-as handoffs (a super admin flagged in SQL, a passkey
enrolled in a separate browser context, `impersonate`, then the exchange), aged sign-ins
for the recent-sign-in rule, toast and card locators that still work while a modal hides
the page from the accessibility tree, and request recorders and holds (`page.route`) for
busy states and response bodies the page navigates away from. Prefer a helper from your
own area's file; copy a small one rather than importing from another area.

### Channel seeding and webhook signing

`support/channels.ts` seeds provider connections the way a real connect stores them:
`seedFcmConfig` (with `fakeServiceAccount`), `seedEmailCredentials` for SES, Resend or
Brevo, `connectFakeSmsProvider` (Twilio) and `connectFakeWhatsAppProvider`, and gives each
provider's webhook path. `support/signing.ts` signs what providers sign: `signSvix`
(Resend), `twilioSignature` (over `publicApiUrl`), `hubSignature` (Meta),
`interaktSignature`, `razorpaySignature`, and the API's own unsubscribe and confirmation
links (`signUnsubscribeLink`, `signConfirmLink`). `tests/_helpers/channels-helpers.spec.ts`
shows each in use.

Locators are the ones a person uses: roles, labels and visible text, with `data-slot`
card titles and CSS only where the page gives an element no role or name.

### Factor and browser helpers

`support/factors.ts`: virtual authenticators in their variants (`addAuthenticator`: user
verification verified, failing or unsupported; synced credentials with the backup flags
set; listing and removing credentials), `rejectNextCredentialPrompt` (the next WebAuthn
prompt fails as a dismissed one does), the customer app's passkey screens
(`enrolTenantPasskey`, `signInWithTenantPasskey`, `signInWithPasskeyAutofill`), and
authenticator-app codes (`totpCode(secret, offsetSteps)`, `enrolTotp(page | { ip }, account)`
answering the secret and recovery codes, `nextTotpCode`, `signInWithTotp`). The codes come
from otplib, not from the API's own implementation. The stack turns on
`PASSKEYS_FOR_TENANTS` and sets a per-run `MFA_ENCRYPTION_KEY`.

Chromium's virtual authenticator answers the sign-in page's passkey autofill at once, so a
tab holding a customer passkey signs straight back in on `/login`. Call
`blockPasskeyAutofill(page)` first when a test means to use the sign-in page itself.

`support/browser-tools.ts`: `readDownload` / `downloadFrom` (bytes, BOM, line endings, and
the text with BOM and CR made visible), `decodeQr` / `decodeQrOnPage` (jsqr), `mobileContext`
(iPhone or Pixel), `fixedLocaleContext` (default en-IN, Asia/Kolkata), `allowClipboard` and
`readClipboard`. `tests/_helpers/factors.spec.ts` shows each in use.

### Worker jobs on demand

`support/jobs.ts`: `runJobNow(name)` runs one of the worker's periodic jobs now, the way
its cron does, and answers `{ result, output }`. The jobs are in-process crons
(`@nestjs/schedule`), not queued jobs, so nothing in Redis can start one early; instead a
short-lived process (`support/run-job.cjs`, from `apps/api` with the stack's environment)
builds the built worker's module through Nest's testing module with the schedule explorer
and the BullMQ registrar replaced, so it mounts no cron and consumes no queue, calls the
scheduler method the cron calls, and exits. It refuses to run if any cron was mounted.
The stack's worker keeps its own schedule, which these jobs already tolerate (claims,
advisory locks, conditional updates). Names (`WORKER_JOBS`): `billing-reconcile`,
`billing-outbox`, `mau-notices`, `usage-rollup`, `factor-reset-sweep`,
`incident-reminders`, `segment-refresh` and `journey-tick`.

- Each cron method catches and logs its own failures, so a run whose output has a Nest
  `ERROR` line throws; pass `{ allowErrors: true }` to read the output instead.
- `segment-refresh` only enqueues; the stack's worker materialises, so poll
  `last_materialized_at` afterwards. Jobs keyed on time (the usage roll-up's days,
  factor-reset waits, incident ages, journey waits) are moved by ageing rows in SQL.
- The once-a-minute jobs (`billing-outbox`, `incident-reminders`, `journey-tick`) also run
  on the stack's own worker, so a case cannot tell whose run did the work; assert the
  outcome, not who produced it.
- It runs the built API (`apps/api/dist`): rebuild (run without `E2E_SKIP_BUILD`) after
  changing worker code.

`tests/_helpers/jobs.spec.ts` shows it in use.

## Known gaps

- **P1 and P2 cases are not automated yet.** The area folders hold the P0 cases only.
- **Chromium only.** WebKit and Firefox are not run yet. WebKit needs its own answer for
  the passkey specs (the virtual authenticator is a Chromium DevTools feature), and the
  phone cases use Chromium with an iPhone or Pixel profile, not Safari.
- **Account email reaches a stub, not an inbox.** Mail is recorded by the provider stub
  as Brevo's API received it, and tests read it back (subjects, links, notices); delivery,
  rendering in mail clients and Brevo's own checks are not covered. With account email
  always on, the cases that need it off (refusals worded for a server without it) are
  skipped.
- **Amazon is not stubbed.** SES connects, SES events and SNS subscription confirmation
  need real AWS; the SES webhook specs stop at the checks made before any certificate is
  fetched.
- **Real providers and devices.** Real FCM delivery to a device, real Twilio, Meta,
  Gupshup, Interakt and Mixpanel accounts, and real phones and apps for deep links are
  manual.
- **Outbound webhooks and DNS.** Webhook deliveries need a public receiver, and domain
  proof needs a real TXT record, so both are manual beyond the address checks and
  refusals.
- **Failure injection.** Redis or Postgres going away and a database failure inside a
  webhook are not covered.
- **Billing stops at the mock.** The real Razorpay Checkout (its script, frames and
  content security policy) is replaced in the browser.
- **Deployment checks.** Production config refusals, nginx and the server scripts are
  checked on a deployed stage, not here.
- The specs run against the Vite dev servers (React StrictMode on), not a production
  build, so the production content security policies are not exercised.
