// PM2 processes of one Chumbaq environment (deploy-setup.sh and deploy-update.sh run
// `PM2_PREFIX=<site> pm2 startOrReload ecosystem.config.cjs --env production --only <name>`,
// one process at a time, the customer API first). Every log line carries an ISO 8601 time
// with its offset, so the 180-day logs CERT-In asks for are unambiguous; pm2-logrotate
// (set up by scripts/server-security.sh) rotates them daily.
const path = require('path');

const LOG_DATE_FORMAT = 'YYYY-MM-DDTHH:mm:ss.SSSZ';
// chumbaq for prod, chumbaq-stage for stage: two environments can share a server.
const PREFIX = process.env.PM2_PREFIX || 'chumbaq';

const app = (name, entry) => ({
  name: `${PREFIX}-${name}`,
  script: `dist/${entry}`,
  // Each process loads its .env as ../../.env from where it runs.
  cwd: path.join(__dirname, 'apps/api'),
  log_date_format: LOG_DATE_FORMAT,
  env_production: { NODE_ENV: 'production' },
});

module.exports = {
  apps: [
    // The customer API applies migrations at boot, so it starts first.
    app('api', 'main.js'),
    app('admin-api', 'main-admin.js'),
    // Queued sends, retention pruning, incident reminders and the clock check.
    app('worker', 'worker.js'),
  ],
};
