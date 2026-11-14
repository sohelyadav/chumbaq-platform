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

## Security

Please report vulnerabilities privately to security@chumbaq.com rather than in a public issue.

## Licence

[GNU AGPL v3](LICENSE). If you run a modified version as a network service, you must offer
its source to its users. For a commercial licence or enterprise support, contact
hello@chumbaq.com.
