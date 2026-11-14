# End-to-end tests

Playwright tests that drive the customer app and the admin app in a real browser,
against the whole stack: the customer API, the admin API, the worker and both Vite dev
servers, on a database of their own.

## Running

```bash
npm run test:e2e                         # headless, every spec
npm run test:e2e:ui                      # Playwright's UI mode
npm run test:e2e -- tests/team.spec.ts   # one spec
E2E_SKIP_BUILD=1 npm run test:e2e        # skip rebuilding the API (when only specs or the web app changed)
```

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

On top of the `.env`, the apps get per-run values: fresh JWT secrets and credentials
key, account email switched on against the provider stub (a fake `PLATFORM_BREVO_API_KEY`
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

| Spec | Covers |
|---|---|
| `auth.spec.ts` | Sign up (form, then the sign-up link), sign out, the dashboard refusing a signed-out visitor, the wrong-password message, signing in, a reload keeping the session, and a used sign-up link being refused. |
| `projects-links.spec.ts` | Creating a first project and a short link with a custom code, opening it on the API's root redirect (`GET /<code>`, a 302 to the destination), and the link's dashboard counting the click (polled: clicks are recorded after the redirect answers). |
| `team.spec.ts` | An owner invites a member; the invite is mailed and its link also shown once; the teammate opens the mailed link signed out, signs in, and accepts; as a member they see no API keys, no invite form, no remove buttons and no activity log; the owner removes them and the project leaves their list. |
| `campaigns.spec.ts` | People arrive through the SDK's identify route; the owner saves the email sender (opt-in requirement off); the composer counts the audience (people opted out or with no address left out) and the campaign is scheduled a month ahead and listed as scheduled. |
| `billing.spec.ts` | Staff create a plan and price through the admin API (checked against the mock's plan); the customer sees it, gives billing details, "pays" in a stand-in for Razorpay Checkout, and becomes active only when the signed `subscription.activated` webhook arrives; cancels at the period end (and the mock receives the cycle-end cancel); then "Keep my plan" makes a successor that starts at the period end, authorised by a signed `subscription.authenticated`. |
| `_helpers/stubs.spec.ts` | The provider stub and mailbox: a sign-up mails a working `/complete-signup` link (and a second sign-up an "already registered" one); a Twilio connect and SMS test send reach the stub, and an injected 401 comes back as a failed test send. |
| `admin.spec.ts` | A super admin granted with `npm run admin:grant` enrols a passkey (Chromium's virtual authenticator) on `/enrol`, signs in with it, finds a tenant, starts view-as with a reason, follows the one-time link into the customer app, sees the read-only banner and the tenant's project, has a write refused, and exits back to the admin app. |

Locators are the ones a person uses: roles, labels and visible text.

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

## Known gaps

- **Chromium only.** WebKit and Firefox are not run yet. WebKit needs its own answer for
  the passkey spec (the virtual authenticator is a Chromium DevTools feature).
- **Account email reaches a stub, not an inbox.** Mail is recorded by the provider stub
  as Brevo's API received it; delivery, rendering in mail clients and Brevo's own
  checks are not covered. The verify-email flow, password reset and security notices
  have no specs yet.
- **Channel providers are stubs.** Connects, test sends and deliveries can now reach the
  provider stub, but only the stub's spec uses it so far: the campaigns spec still seeds
  the connection directly in the database (`support/seed.ts`) with a fake key, and stops
  at scheduling, with the opt-in requirement switched off (a required opt-in counts
  only once the person confirms it from an email the provider sends). SES is not
  stubbed. Push, SMS and WhatsApp campaigns, delivery, provider webhooks and journeys
  are not covered.
- **Billing stops at the mock.** The real Razorpay Checkout (its script, frames and
  content security policy) is replaced in the browser, and only the subscription
  webhooks the spec needs are sent: no charges, invoices, payments, refunds, halts,
  the worker's cancel outbox or reconcile job.
- **Admin.** Staff sign-in with an operator's enrolment code (needed whenever
  `SUPER_ADMIN_PASSKEY_REQUIRED` is on, as in production) and the second staff passkey
  production asks for are not covered.
- **No email entry in the project sidebar.** The campaigns spec opens the Email page by
  its address because the project sidebar has no entry for it.
- The specs run against the Vite dev servers (React StrictMode on), not a production
  build, so the production content security policies are not exercised.
