# Chumbaq

Open-source customer engagement platform: short links with deep-link routing, click → install
→ conversion attribution, in-app messages, push, email, SMS and WhatsApp, audiences and
journeys, with consent, erasure and export built in.

Use the hosted version at [chumbaq.com](https://chumbaq.com), or run it on your own server.

## What's in this repo

| Path | What it is |
|---|---|
| `apps/api` | NestJS API (customer API, admin API and background worker), TypeORM + Postgres, BullMQ + Redis |
| `apps/web` | Customer dashboard (React + Vite) |
| `apps/admin` | Operator admin app (React + Vite) |
| `packages/shared` | Types shared by the API and both apps |
| `scripts/` | Local dev runner and server setup/update scripts |

Client SDKs live in their own repos:
[JavaScript](https://github.com/sohelyadav/chumbaq-js-sdk) ·
[iOS](https://github.com/sohelyadav/chumbaq-ios-sdk) ·
[Android](https://github.com/sohelyadav/chumbaq-android-sdk) ·
[Flutter](https://github.com/sohelyadav/chumbaq-flutter-sdk)

## Run it locally

Needs Node 22+, Postgres and Redis.

```bash
npm install
cp .env.example .env      # then fill in the values it asks for
npm run build:shared
npm run dev:all           # API, worker, admin API, dashboard and admin app
```

Optional demo data (drops and recreates the local database; refuses `NODE_ENV=production`):
`npm run seed`.

## Tests

```bash
npm run lint              # tsc --noEmit in every workspace
npm test                  # Jest unit tests (apps/api)
cd apps/api && npm run test:int   # integration tests, needs a Postgres test database
```

## Self-hosting

`scripts/deploy-setup.sh` sets up an Ubuntu 22.04+ server (Postgres, Redis, nginx, PM2,
certbot) and `scripts/deploy-update.sh` updates it. Read the top of each script for the
settings; set `APP_SERVER_NAME` and `ADMIN_SERVER_NAME` to your own hosts.

Billing is optional and off by default: with it off there are no plans, no plan limits and
no billing routes, and the project and seat limits are `MAX_PROJECTS_PER_ACCOUNT` and
`MAX_SEATS_PER_ACCOUNT`. To charge for plans through Razorpay Subscriptions, set all of:

| Variable | Notes |
|---|---|
| `RAZORPAY_KEY_ID` | `rzp_test_…` or `rzp_live_…`; billing stays off unless all three keys are set |
| `RAZORPAY_KEY_SECRET` | |
| `RAZORPAY_WEBHOOK_SECRET` | the secret of the Razorpay webhook pointed at the API |
| `BILLING_GRACE_DAYS` | days a halted subscription keeps its plan, 1 to 60, default 14 |
| `BILLING_ENABLED` | optional; `false` keeps billing off even with keys set |

Some of the three keys without the others stop the app at start-up, unless `BILLING_ENABLED=false`.

With billing on, every account without a paid plan is on the built-in `free` plan. It starts
with no limits of its own, so free accounts keep `MAX_PROJECTS_PER_ACCOUNT` and
`MAX_SEATS_PER_ACCOUNT` until you give the free plan its own; on any other plan an empty seat
or MAU limit means unlimited.

Plans live in the database, not in the code: staff create them and set their limits on the
admin app's Plans page, which works with billing off too, so limits can be ready before billing
is switched on. Prices are entered excluding GST. For each price, first create a Razorpay plan
that charges the amount the Add price dialog shows (the price with 18% GST, in INR, every 1
month or 1 year), then paste its `plan_…` id: the admin API fetches the plan from Razorpay and
refuses it unless the amount, currency and period match. A new price replaces the current one
for new subscriptions; existing subscribers keep theirs.

Point a Razorpay webhook at `https://<your API host>/api/billing/webhooks/razorpay` with the
secret in `RAZORPAY_WEBHOOK_SECRET`, subscribed to `subscription.authenticated`, `.activated`,
`.charged`, `.pending`, `.halted`, `.cancelled`, `.completed` and `.updated`, `payment.failed`,
`invoice.paid`, `invoice.expired` and `refund.processed`. Subscription state changes only from
those verified webhooks and the server's own calls to Razorpay, so run the worker too: it sends
cancellations and catches up on missed events. Test with `rzp_test_` keys first, in a
production build of the dashboard (`npm run build:web`, then `npx vite preview` in `apps/web`):
its Content Security Policy applies only there, and Checkout must open and pay without the
browser console reporting a blocked request. Add any Razorpay origin it reports to the policy
in `apps/web/vite.config.ts`.

## Security

Please report vulnerabilities privately to security@chumbaq.com rather than in a public issue.

## Licence

[GNU AGPL v3](LICENSE). If you run a modified version as a network service, you must offer
its source to its users. For a commercial licence or enterprise support, contact
hello@chumbaq.com.
