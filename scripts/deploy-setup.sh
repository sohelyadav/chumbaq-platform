#!/bin/bash
set -e

# =============================================================
# Chumbaq - First-time server setup
# Run once per environment on an Ubuntu 22.04+ server (x86_64 or arm64). Prod and stage
# can share one server: each gets its own checkout, ports, database, Redis DB number,
# pm2 processes and nginx sites. Safe to run again: an existing .env is kept, and an
# nginx site that already has TLS (from certbot) is left as it is.
#
# Usage:
#   REPO_URL=git@github.com:you/chumbaq-platform.git DEPLOY_ENV=prod  ./deploy-setup.sh
#   REPO_URL=git@github.com:you/chumbaq-platform.git DEPLOY_ENV=stage ./deploy-setup.sh
# REPO_URL is only needed when APP_DIR has no checkout yet. BRANCH defaults to main.
# =============================================================

# prod or stage. Everything below that differs between the two follows from it.
DEPLOY_ENV="${DEPLOY_ENV:-prod}"
case $DEPLOY_ENV in
  prod)
    ENV_DIR=/home/ubuntu/chumbaq ENV_SITE=chumbaq ENV_APP_HOST=app.chumbaq.com
    ENV_ADMIN_HOST=admin.chumbaq.com ENV_API_PORT=3000 ENV_ADMIN_API_PORT=3011
    ENV_DB=chumbaq ENV_REDIS_DB=0
    ;;
  stage)
    ENV_DIR=/home/ubuntu/chumbaq-stage ENV_SITE=chumbaq-stage ENV_APP_HOST=stage.chumbaq.com
    ENV_ADMIN_HOST=admin-stage.chumbaq.com ENV_API_PORT=3100 ENV_ADMIN_API_PORT=3111
    ENV_DB=chumbaq_stage ENV_REDIS_DB=1
    ;;
  *)
    echo "DEPLOY_ENV must be prod or stage, not '$DEPLOY_ENV'" >&2
    # shellcheck disable=SC2317 # return when sourced, exit when run
    return 1 2>/dev/null || exit 1
    ;;
esac

# Overridable so the spec can run the whole script against a scratch directory.
APP_DIR="${APP_DIR:-$ENV_DIR}"
# nginx site names ("<site>", "<site>-admin") and the pm2 process name prefix.
SITE="$ENV_SITE"
API_PORT="$ENV_API_PORT"
ADMIN_API_PORT="$ENV_ADMIN_API_PORT"
DB_NAME="$ENV_DB"
DB_USER="$ENV_DB"
REDIS_DB="$ENV_REDIS_DB"
REPO_URL="${REPO_URL:-}"
BRANCH="${BRANCH:-main}"

# The customer dashboard host. nginx serves the dashboard there and proxies /api, the
# short-link redirect and /.well-known to the API, so it is also the API's public URL and
# the short-link domain (the API builds short links as APP_URL/<code>).
APP_SERVER_NAME="${APP_SERVER_NAME:-$ENV_APP_HOST}"

# The staff admin app and its API get their own host, so nothing for admin is served
# from the customer one. Override when running: ADMIN_SERVER_NAME=admin.example.com
# ADMIN_APP_URL and VITE_ADMIN_APP_URL in the .env are written from it; on an existing
# .env that names another host the script stops (staff passkeys are bound to the host).
ADMIN_SERVER_NAME="${ADMIN_SERVER_NAME:-$ENV_ADMIN_HOST}"

# Shared by every environment on the server; read from redis.conf when already set.
REDIS_PASSWORD="${REDIS_PASSWORD:-}"
# Optional allow-list for the admin host: IPs or CIDRs, separated by commas or spaces,
# e.g. ADMIN_ALLOWED_IPS="203.0.113.7, 198.51.100.0/24". Empty allows every address
# (staff sign-in still needs a password and a passkey or authenticator app). nginx
# compares the connecting address, so behind a load balancer configure real_ip first.
ADMIN_ALLOWED_IPS="${ADMIN_ALLOWED_IPS:-}"
NGINX_SITES="${NGINX_SITES:-/etc/nginx/sites-available}"
NGINX_ENABLED="${NGINX_ENABLED:-/etc/nginx/sites-enabled}"

# The CERT-In pieces (logs, clock, Redis, alarms, the log collector): shared with
# deploy-update.sh. SYSTEM_ROOT (tests only) moves every system path under a scratch dir.
# shellcheck source=server-security.sh
source "$(dirname "${BASH_SOURCE[0]}")/server-security.sh"

# --- Functions (apps/api/src/config/deploy-setup.spec.ts sources this file and runs them) ---

# The name goes into the .env and the nginx config unquoted, so only host name characters.
# A bash match, not grep: grep tests each line, so a value with a newline in it would pass
# on its first line and write its second into the .env. No leading '-' or '.' either.
# $1 = variable name, $2 = its value.
check_host_name() {
  if ! [[ $2 =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
    echo "$1: '$2' is not a host name" >&2
    return 1
  fi
}

check_admin_server_name() {
  check_host_name ADMIN_SERVER_NAME "$ADMIN_SERVER_NAME"
}

# Both hosts go into the .env and nginx, and must differ: the admin block must never
# answer for the dashboard's name.
check_server_names() {
  check_admin_server_name || return 1
  check_host_name APP_SERVER_NAME "$APP_SERVER_NAME" || return 1
  if [ "$(printf '%s' "$APP_SERVER_NAME" | tr '[:upper:]' '[:lower:]')" = \
    "$(printf '%s' "$ADMIN_SERVER_NAME" | tr '[:upper:]' '[:lower:]')" ]; then
    echo "APP_SERVER_NAME and ADMIN_SERVER_NAME are both '$APP_SERVER_NAME'; they must differ" >&2
    return 1
  fi
}

# Random secrets for a new .env. Hex for the database and Redis passwords, since they
# are also written into SQL and redis.conf.
random_hex() { openssl rand -hex "$1"; }
random_base64() { openssl rand -base64 "$1" | tr -d '\n'; }

# $1 = file. The quoted heredocs keep every line literal. What is filled in comes from
# the already checked host names, the environment's own numbers and names, and secrets
# generated here (hex or base64, so nothing that needs quoting in a .env).
write_env_template() {
  {
    printf '# Written by scripts/deploy-setup.sh for DEPLOY_ENV=%s. The secrets were generated\n' "$DEPLOY_ENV"
    printf '# on this server: back up MFA_ENCRYPTION_KEY and CREDENTIALS_ENCRYPTION_KEY apart\n'
    printf '# from the database (losing either loses TOTP sign-in or the stored credentials).\n'
    printf 'NODE_ENV=production\n\n'
    printf '# Database\nDATABASE_HOST=localhost\nDATABASE_PORT=5432\n'
    printf 'DATABASE_USER=%s\nDATABASE_PASSWORD=%s\nDATABASE_NAME=%s\n\n' "$DB_USER" "$(random_hex 24)" "$DB_NAME"
    printf '# Redis, shared by every environment on this server. Each uses its own DB number,\n'
    printf '# so their queues never mix.\n'
    printf 'REDIS_HOST=127.0.0.1\nREDIS_PORT=6379\nREDIS_PASSWORD=%s\nREDIS_DB=%s\n\n' "$REDIS_PASSWORD" "$REDIS_DB"
    printf '# API. nginx serves the dashboard on APP_SERVER_NAME and proxies /api, the short-link\n'
    printf '# redirect and /.well-known to this port, so the API is reached on the same host.\n'
    printf 'API_PORT=%s\n' "$API_PORT"
    printf 'APP_URL=https://%s\nAPI_BASE_URL=https://%s\nCORS_ORIGINS=https://%s\n' \
      "$APP_SERVER_NAME" "$APP_SERVER_NAME" "$APP_SERVER_NAME"
    printf '# Required by the API; short links themselves are built as APP_URL/<code>.\n'
    printf 'SHORT_LINK_DOMAIN=%s\n\n' "$APP_SERVER_NAME"
    printf '# JWT. Two different values.\n'
    printf 'JWT_SECRET=%s\nJWT_REFRESH_SECRET=%s\n' "$(random_base64 64)" "$(random_base64 64)"
  } > "$1"
  cat >> "$1" << 'ENVEOF'
JWT_EXPIRATION=15m
JWT_REFRESH_EXPIRATION=7d
# A session ends this long after sign-in however often it refreshes. At least
# JWT_REFRESH_EXPIRATION, or the API refuses to start.
SESSION_MAX_AGE=30d

# Two-factor sign-in. Back it up apart from the database: losing it locks out every
# TOTP user.
ENVEOF
  printf 'MFA_ENCRYPTION_KEY=%s\n\n' "$(random_base64 32)" >> "$1"
  cat >> "$1" << 'ENVEOF'
# Encrypts stored push, email, SMS and WhatsApp provider credentials.
# Back it up: losing it loses those credentials.
ENVEOF
  printf 'CREDENTIALS_ENCRYPTION_KEY=%s\n\n' "$(random_hex 32)" >> "$1"
  cat >> "$1" << 'ENVEOF'
# Days of sign-in history (auth_events) to keep. The worker refuses to start below 180,
# the minimum India's CERT-In rules require.
AUTH_EVENT_RETENTION_DAYS=365
# Days of each project's activity log to keep (at least 180).
ACTIVITY_LOG_RETENTION_DAYS=365

# CERT-In readiness (scripts/server-security.sh). Days of server logs (nginx, system,
# Postgres, Redis, the apps) to keep: at least 180; setup refuses less.
LOG_RETENTION_DAYS=365
# Time servers; empty means NIC's and NPL's (samay1.nic.in samay2.nic.in time.nplindia.org).
# Outside India's network, use a source traceable to them, space separated.
NTP_SERVERS=
# Where to report a security problem: an email address or an https URL. Served as
# /.well-known/security.txt when set.
SECURITY_CONTACT=
# Alarms for unusually large exports (rows per account per hour) and reads (requests per
# dashboard account per 10 minutes). They alarm only; nothing is blocked.
BULK_EXPORT_ALERT_ROWS=50000
API_DOWNLOAD_ALERT_REQUESTS=2000
# SECURITY_ALERT_TOKEN is added by setup, for prod (the server's alarms go to its admin API).

# Account email (password resets, invitations, security notices) through Brevo.
# Optional: without it the platform runs and those emails are not sent.
# PLATFORM_BREVO_API_KEY=xkeysib-...
# PLATFORM_EMAIL_FROM=Chumbaq <noreply@chumbaq.com>

# Paid plans through Razorpay Subscriptions. Billing stays off unless all three keys are set.
# RAZORPAY_KEY_ID=
# RAZORPAY_KEY_SECRET=
# RAZORPAY_WEBHOOK_SECRET=
# BILLING_GRACE_DAYS=14
# Tax added to new prices, in basis points (1800 is 18%). Default 0: no tax.
# BILLING_TAX_RATE_BPS=0

# Admin API (staff only), a second process on the same database. nginx serves the admin
# app on ADMIN_SERVER_NAME and proxies its /api to this port on 127.0.0.1.
ENVEOF
  printf 'ADMIN_API_PORT=%s\n' "$ADMIN_API_PORT" >> "$1"
  cat >> "$1" << 'ENVEOF'
# Required in production: the admin API refuses to start without it, or when
# STAFF_WEBAUTHN_RP_ID / STAFF_WEBAUTHN_ORIGINS do not match its host. Staff passkeys
# are bound to that host name, which cannot change once staff have enrolled.
ENVEOF
  printf 'ADMIN_APP_URL=https://%s\n' "$ADMIN_SERVER_NAME" >> "$1"
  cat >> "$1" << 'ENVEOF'
# Baked into the customer dashboard at build (its "Admin app" link and where view-as
# ends). A production build refuses to run without it. Rebuild apps/web after changing it.
ENVEOF
  printf 'VITE_ADMIN_APP_URL=https://%s\n' "$ADMIN_SERVER_NAME" >> "$1"
  cat >> "$1" << 'ENVEOF'

# Optional
GEOIP_ENABLED=true
ENVEOF
  chmod 600 "$1"
}

# $1 = file, $2 = variable. The value the last line setting it gives, as dotenv reads it
# (dotenv takes the last one), or nothing.
env_value() {
  local lines
  lines=$(env_lines "$1" "$2") || return 0
  env_line_value "$(printf '%s\n' "$lines" | tail -n 1)"
}

# $1 = file. The database role, database and password the .env names, checked before they
# go into SQL: a name is lower-case letters, digits and _, a password letters and digits.
# The script's own .env always passes; one edited by hand to anything else is refused.
read_database_settings() {
  DB_USER=$(env_value "$1" DATABASE_USER)
  DB_NAME=$(env_value "$1" DATABASE_NAME)
  DB_PASSWORD=$(env_value "$1" DATABASE_PASSWORD)
  if ! [[ $DB_USER =~ ^[a-z_][a-z0-9_]*$ && $DB_NAME =~ ^[a-z_][a-z0-9_]*$ ]]; then
    echo "DATABASE_USER and DATABASE_NAME in $1 must be lower-case letters, digits and _" >&2
    return 1
  fi
  if ! [[ $DB_PASSWORD =~ ^[A-Za-z0-9]{16,}$ ]]; then
    echo "DATABASE_PASSWORD in $1 must be at least 16 letters and digits (openssl rand -hex 24)" >&2
    return 1
  fi
}

# $1 = a URL as written in the .env. Its host name, lower-cased, as new URL() in the API
# and the web build reads it: the authority ends at the first / ? # or \ (all separators
# in http and https URLs), and its host is what follows the last '@' in it (user info such
# as the "admin.new.com:x" of https://admin.new.com:x@admin.old.com is not the host).
# Anything but an http or https URL gives nothing, which never matches: other schemes
# split the authority differently, and the API and the build need https anyway. So a
# misreading here can only ever be a refusal, never a pass.
url_host() {
  local value="${1%$'\r'}"
  value="${value#[\"\'\`]}"
  value="${value%[\"\'\`]}"
  value=$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')
  case $value in
    https://* | http://*) value="${value#*://}" ;;
    *) return 0 ;;
  esac
  value="${value%%[/?#\\]*}"
  value="${value##*@}"
  value="${value%%:*}"
  printf '%s' "$value"
}

# $1 = file, $2 = variable. Every line that sets it the way dotenv reads a .env (the API
# and Vite both use dotenv): optional leading space, an optional "export ", the name, then
# "=" or ":" with any space around it. Commented lines do not match. A line dotenv would
# not quite take may match too, which can only make the check below refuse, never pass.
env_lines() {
  grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1"
}

# $1 = one such line. Its value as dotenv takes it: quoted, up to the closing quote;
# unquoted, up to a '#' (where dotenv ends it), with the space around it trimmed.
env_line_value() {
  local value="${1%$'\r'}" quote
  value=$(printf '%s' "$value" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_.-]+[[:space:]]*[=:]//')
  value="${value#"${value%%[![:space:]]*}"}"
  quote="${value:0:1}"
  case $quote in
    \"|\'|\`)
      value="${value:1}"
      value="${value%%"$quote"*}"
      ;;
    *)
      value="${value%%#*}"
      value="${value%"${value##*[![:space:]]}"}"
      ;;
  esac
  printf '%s' "$value"
}

# $1 = file. An existing .env: add ADMIN_APP_URL or VITE_ADMIN_APP_URL if missing (a
# .env from before either existed would stop the admin API or the web build), and stop
# if either names another host than ADMIN_SERVER_NAME. Staff passkeys are bound to the
# admin host (the RP ID), so moving it is never done quietly: going on would write nginx
# for one host while the API and the dashboard expect another. Every line setting the
# name is checked, not just the first: dotenv takes the last one, and an "export " or
# indented line does set it, so calling it missing would append a line that quietly wins.
ensure_admin_app_urls() {
  local name want line lines mismatch=""
  want=$(printf '%s' "$ADMIN_SERVER_NAME" | tr '[:upper:]' '[:lower:]')
  # Checked before anything is added, so a refusal leaves the file as it was.
  for name in ADMIN_APP_URL VITE_ADMIN_APP_URL; do
    lines=$(env_lines "$1" "$name") || continue
    while IFS= read -r line; do
      [ "$(url_host "$(env_line_value "$line")")" = "$want" ] || mismatch="$mismatch    ${line%$'\r'}"$'\n'
    done <<< "$lines"
  done
  if [ -n "$mismatch" ]; then
    {
      echo "ADMIN_SERVER_NAME is $ADMIN_SERVER_NAME, but $1 has:"
      printf '%s' "$mismatch"
      echo "  Nothing was changed, and nginx was not written."
      echo "  Staff passkeys are bound to the admin app's host (the WebAuthn RP ID, from"
      echo "  ADMIN_APP_URL), so moving it means every staff member enrols a new passkey."
      echo "  To keep the current host, run this again with ADMIN_SERVER_NAME=<that host>."
      echo "  To move it on purpose: set ADMIN_APP_URL and VITE_ADMIN_APP_URL (and"
      echo "  STAFF_WEBAUTHN_RP_ID / STAFF_WEBAUTHN_ORIGINS, if set) to https://$ADMIN_SERVER_NAME"
      echo "  in $1, one line each, run this again with ADMIN_SERVER_NAME=$ADMIN_SERVER_NAME,"
      echo "  then have each staff member enrol again (npm run admin:staff-enrolment -- <email>)."
    } >&2
    return 1
  fi
  for name in ADMIN_APP_URL VITE_ADMIN_APP_URL; do
    if ! env_lines "$1" "$name" > /dev/null; then
      printf '%s=https://%s\n' "$name" "$ADMIN_SERVER_NAME" >> "$1"
      echo "  Added $name=https://$ADMIN_SERVER_NAME to $1"
    fi
  done
}

# stdin to stdout, with __APP_DIR__, __API_PORT__ and __ADMIN_API_PORT__ replaced. The site
# bodies stay quoted heredocs (nginx's own $variables untouched); only these are filled in.
# APP_DIR is checked first: it goes into an nginx root line.
fill_placeholders() {
  if ! [[ $APP_DIR =~ ^/[A-Za-z0-9._/-]+$ ]]; then
    echo "APP_DIR: '$APP_DIR' must be an absolute path of letters, digits, . _ - and /" >&2
    return 1
  fi
  sed -e "s|__APP_DIR__|$APP_DIR|g" -e "s|__API_PORT__|$API_PORT|g" \
    -e "s|__ADMIN_API_PORT__|$ADMIN_API_PORT|g"
}

# The catch-all: a request for a host name no site names (a bare IP, a stale DNS record,
# a scanner) is closed without an answer, so it never reaches the dashboard or an admin
# block. Shared by every environment on the server; each run writes the same file.
default_site_config() {
  cat << 'NGINXEOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    return 444;
}
NGINXEOF
}

customer_site_config() {
  printf 'server {\n    listen 80;\n    listen [::]:80;\n    server_name %s;\n\n' "$APP_SERVER_NAME"
  fill_placeholders << 'NGINXEOF'
    # Staff routes live only on the admin host. The customer API already answers 404 for
    # them; this keeps it so even if a proxy target here is ever pointed at the wrong port.
    location /api/admin/ {
        return 404;
    }
    location /api/staff/ {
        return 404;
    }
    # Server scripts' alarm route lives on the admin API, reached only from 127.0.0.1.
    location /api/internal/ {
        return 404;
    }
    # RFC 9116, from SECURITY_CONTACT (404 when it is not set).
    location = /.well-known/security.txt {
        alias /etc/chumbaq/security.txt;
        default_type text/plain;
    }

    # Frontend - Vite static build. The page's own CSP is in a meta tag written at build;
    # framing can only be refused by a header.
    location / {
        add_header Content-Security-Policy "frame-ancestors 'none'" always;
        add_header X-Frame-Options "DENY" always;
        add_header X-Content-Type-Options "nosniff" always;
        # Same as the meta tag in index.html; this one also covers anything loaded before it.
        add_header Referrer-Policy "strict-origin" always;
        root __APP_DIR__/apps/web/dist;
        index index.html;
        try_files $uri $uri/ /index.html;
    }

    # API proxy
    location /api/ {
        proxy_pass http://127.0.0.1:__API_PORT__;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
        proxy_cache_bypass $http_upgrade;
    }

    # Short links. A link is APP_URL/<code>: the dashboard's /:shortCode page sends the
    # browser to /redirect/<code>, and the API serves the redirect at /api/<code> (the URI
    # on proxy_pass replaces /redirect/ with /api/). Without it every short link is a 404.
    location /redirect/ {
        proxy_pass http://127.0.0.1:__API_PORT__/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }

    # App link verification (apple-app-site-association, assetlinks.json) for short links
    # on this host. The API serves them; without this the dashboard's index.html would
    # answer, and iOS and Android would refuse to open the app.
    location /.well-known/ {
        proxy_pass http://127.0.0.1:__API_PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }
}
NGINXEOF
}

# One allow line per ADMIN_ALLOWED_IPS entry, then deny all; nothing when it is empty.
admin_access_lines() {
  local entry
  [ -n "$ADMIN_ALLOWED_IPS" ] || return 0
  for entry in $(echo "$ADMIN_ALLOWED_IPS" | tr ',' ' '); do
    # Only address characters, so a typo cannot add other nginx directives.
    if ! printf '%s' "$entry" | grep -Eq '^[0-9A-Fa-f:.]+(/[0-9]{1,3})?$'; then
      echo "ADMIN_ALLOWED_IPS: '$entry' is not an IP address or CIDR range" >&2
      return 1
    fi
    printf '    allow %s;\n' "$entry"
  done
  printf '    deny all;\n'
}

# The admin host: the built admin app, and its API on the same origin, so the staff
# refresh cookie stays host-only and no CORS is needed. Port 80 only: certbot adds the
# 443 block and the redirect when HTTPS is set up (see the end of this script).
admin_site_config() {
  local access
  access=$(admin_access_lines) || return 1
  printf 'server {\n    listen 80;\n    server_name %s;\n\n' "$ADMIN_SERVER_NAME"
  [ -z "$access" ] || printf '%s\n' "$access"
  fill_placeholders << 'NGINXEOF'

    # On every response, the API's included. The page's own CSP (nothing from any other
    # origin, no inline script) is a meta tag written at build; framing and the referrer
    # policy need headers.
    add_header Content-Security-Policy "frame-ancestors 'none'" always;
    add_header X-Frame-Options "DENY" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header X-Robots-Tag "noindex, nofollow" always;

    root __APP_DIR__/apps/admin/dist;
    index index.html;

    location / {
        try_files $uri $uri/ /index.html;
    }

    # Server scripts' alarm route: only from 127.0.0.1, never through nginx.
    location /api/internal/ {
        return 404;
    }
    location = /.well-known/security.txt {
        alias /etc/chumbaq/security.txt;
        default_type text/plain;
    }

    # Admin API, bound to 127.0.0.1 (ADMIN_API_HOST). Only /api/health, /api/staff/auth/*
    # and /api/admin/* exist there; everything else is 404.
    location /api/ {
        proxy_pass http://127.0.0.1:__ADMIN_API_PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Request-Id $request_id;
    }
}
NGINXEOF
}

# $1 = site file. certbot --nginx edits the site in place (443 block, certificate paths,
# the port 80 redirect, each line marked "managed by Certbot"); writing the HTTP-only
# config over it would take HTTPS away, and the Secure staff cookie with it.
# 0 = has TLS, 1 = has none (or no file), 2 = could not tell. Read through sudo, since
# certbot's files may be root's alone, in one call that prints what it found. sudo's own
# failure (a mistyped password after the build outlived its timestamp, say) exits 1, the
# same as grep's "no match" and test's "no file", and a later sudo may well work; so only
# a word printed from inside sudo is an answer, and anything else is "could not tell".
TLS_PATTERN='managed by Certbot|ssl_certificate|listen[[:space:]]+([^;]*[^0-9])?443([^0-9]|$)'
has_tls_config() {
  local found
  # shellcheck disable=SC2016 # expanded by the inner sh, from its arguments
  found=$(sudo sh -c '[ -e "$2" ] || { echo absent; exit 0; }
    grep -Eq -- "$1" "$2"; s=$?
    case $s in 0) echo tls ;; 1) echo plain ;; *) echo unreadable ;; esac' sh "$TLS_PATTERN" "$1") || true
  case $found in
    tls) return 0 ;;
    absent | plain) return 1 ;;
    *) return 2 ;;
  esac
}

# $1 = site name, $2 = function printing its config.
write_site() {
  local file="$NGINX_SITES/$1" config status=0
  has_tls_config "$file" || status=$?
  if [ "$status" -eq 0 ]; then
    echo "  $file has TLS set up (certbot), so it was left as it is."
    echo "  To change it, edit it by hand, or delete it, run this again and then certbot again."
    return 0
  fi
  if [ "$status" -ne 1 ]; then
    # Not knowing is not "no TLS": overwriting might take HTTPS away.
    echo "Could not read $file to see whether it has TLS, so it was left as it is." >&2
    echo "  Check sudo works and the file can be read (sudo cat $file), then run this again." >&2
    return 1
  fi
  # Built first, so a refused ADMIN_ALLOWED_IPS entry leaves the old file in place.
  config=$("$2") || return 1
  if sudo grep -Eq '^[[:space:]]*include[[:space:]]' "$file" 2>/dev/null; then
    # Only the site file itself is searched. TLS set up through an include (a snippet
    # with the certificate lines) is the operator's to keep: certbot never does it so.
    echo "  Note: $file had include lines, and TLS set up through an include is not detected."
    echo "  It was replaced with the HTTP-only site; if it served HTTPS, run certbot again."
  fi
  printf '%s\n' "$config" | sudo tee "$file" > /dev/null
}

# $1 = site name. Links it into sites-enabled, unless something else is already there:
# a regular file there is often one certbot edited, and replacing it with a link to the
# HTTP-only site would take HTTPS away.
enable_site() {
  local target="$NGINX_SITES/$1" entry="$NGINX_ENABLED/$1" current
  if [ -L "$entry" ]; then
    current=$(readlink "$entry")
    [ "$current" = "$target" ] && return 0
    echo "  $entry links to $current, not $target, so it was left as it is."
    echo "  To use the script's site: sudo ln -sfn $target $entry"
    return 0
  fi
  if [ -e "$entry" ]; then
    echo "  $entry is a file, not a link to $target, so it was left as it is and nginx serves it."
    echo "  To use the script's site, keep anything you need from it (certbot may have edited"
    echo "  it), then: sudo ln -sfn $target $entry"
    return 0
  fi
  sudo ln -s "$target" "$entry"
}

# Node 22 or later (the repo's engines field), from NodeSource when the system's is older.
install_node() {
  local major
  major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
  if [ "$major" -ge 22 ] 2>/dev/null; then
    echo "  Node $(node -v) is already installed."
    return 0
  fi
  curl -fsSL https://deb.nodesource.com/setup_22.x -o /tmp/nodesource_setup.sh
  sudo bash /tmp/nodesource_setup.sh
  sudo apt install -y nodejs
  rm -f /tmp/nodesource_setup.sh
}

# Redis for the BullMQ queues is shared by every environment on the server, so they share
# its password: the one already in redis.conf, else REDIS_PASSWORD, else a new one. Sets
# REDIS_PASSWORD and noeviction (the default, set explicitly: an evicted job is a campaign
# that silently never sends). setup_redis (server-security.sh) writes the password into
# redis.conf from the .env and restarts Redis.
redis_conf_password() {
  # shellcheck disable=SC2016 # expanded by the inner sh, from its arguments
  sudo sh -c 'grep -E "^requirepass[[:space:]]" "$1" 2>/dev/null | tail -n 1' sh "$(R /etc/redis/redis.conf)" | awk '{print $2}' || true
}

choose_redis_password() {
  local current
  current=$(redis_conf_password)
  if [ -n "$current" ]; then
    REDIS_PASSWORD="$current"
  elif [ -z "$REDIS_PASSWORD" ]; then
    REDIS_PASSWORD=$(random_hex 24)
  fi
  if ! [[ $REDIS_PASSWORD =~ ^[A-Za-z0-9]{16,}$ ]]; then
    echo "The Redis password must be at least 16 letters and digits" >&2
    return 1
  fi
  sudo sed -i -E "s/^#?[[:space:]]*maxmemory-policy[[:space:]].*/maxmemory-policy noeviction/" "$(R /etc/redis/redis.conf)"
}

# $1 = .env. Adds REDIS_PASSWORD (the shared one) and REDIS_DB when missing, and stops if
# the .env names another password than redis.conf has: setup_redis would switch Redis to
# it, and every other environment on the server would lose its queues.
ensure_redis_settings() {
  local current set
  current=$(redis_conf_password)
  set=$(env_value "$1" REDIS_PASSWORD)
  if [ -n "$set" ] && [ -n "$current" ] && [ "$set" != "$current" ]; then
    echo "REDIS_PASSWORD in $1 differs from the one in /etc/redis/redis.conf, which every" >&2
    echo "  environment on this server shares. Set it to that one, then run this again." >&2
    return 1
  fi
  if [ -z "$set" ]; then
    choose_redis_password || return 1
    env_add_if_missing "$1" REDIS_PASSWORD "$REDIS_PASSWORD"
  fi
  env_add_if_missing "$1" REDIS_DB "$REDIS_DB"
}

# nginx (www-data) serves apps/web/dist and apps/admin/dist from APP_DIR, so it must be
# able to pass through every folder above it. Ubuntu 24.04 creates home folders 750, which
# would make every page a 500. Each closed folder gets an ACL letting www-data through, and
# nothing else: it can neither list the folder nor read files that are not world-readable
# (the .env is 600).
allow_nginx_traverse() {
  local dir="$APP_DIR"
  while dir=$(dirname "$dir") && [ "$dir" != "/" ]; do
    if [ -z "$(find "$dir" -maxdepth 0 -perm -o=x 2>/dev/null)" ]; then
      sudo setfacl -m u:www-data:--x "$dir"
    fi
  done
}

# The checkout this environment runs from. A missing one is cloned from REPO_URL; an
# existing one is left on whatever it has (deploy-update.sh moves it).
ensure_checkout() {
  if [ -e "$APP_DIR/package.json" ]; then
    return 0
  fi
  if [ -z "$REPO_URL" ]; then
    echo "$APP_DIR has no checkout. Run again with REPO_URL=<git URL of chumbaq-platform>." >&2
    return 1
  fi
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
}

# The role and database the .env names, with its password. Safe to run again: the role's
# password is set to the .env's every time, so the two cannot drift apart.
setup_database() {
  read_database_settings "$APP_DIR/.env" || return 1
  sudo -u postgres psql -v ON_ERROR_STOP=1 -q \
    -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '$DB_USER') THEN CREATE ROLE $DB_USER LOGIN; END IF; END \$\$;" \
    -c "ALTER ROLE $DB_USER WITH LOGIN PASSWORD '$DB_PASSWORD';"
  if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME'" | grep -q 1; then
    sudo -u postgres createdb -O "$DB_USER" "$DB_NAME"
  fi
}

# $1 = api, admin-api or worker: that process of this environment, from
# ecosystem.config.cjs (which names them PM2_PREFIX-<process> and runs them from apps/api,
# where each loads its .env as ../../.env). Started, or reloaded with the current .env.
pm2_up() {
  PM2_PREFIX="$SITE" pm2 startOrReload "$APP_DIR/ecosystem.config.cjs" --env production \
    --only "$SITE-$1" --update-env
}

# $1 = port. Waits for GET /api/health (which also checks the database) for up to two
# minutes. The customer API applies migrations as it boots, so the admin API and the worker,
# which never change the schema, start only after this.
wait_for_health() {
  local _
  for _ in $(seq 1 60); do
    if curl -fsS -o /dev/null "http://127.0.0.1:$1/api/health"; then
      return 0
    fi
    sleep 2
  done
  echo "Nothing healthy on port $1 after two minutes. See: pm2 logs" >&2
  return 1
}

# The clock, log retention, alarms and the daily file check are the server's, set up with
# DEPLOY_ENV=prod (the alarms go to prod's admin API). Another environment's deploy changes
# files too, so it moves the file baseline on once prod has taken one.
server_wide() { [ "$DEPLOY_ENV" = prod ]; }
update_file_baseline() {
  if server_wide || [ -f "$(R /var/lib/aide/aide.db)" ]; then
    refresh_file_baseline
  fi
}

# Sourced by the tests: stop here, before anything is installed or changed.
if [ "${BASH_SOURCE[0]}" != "$0" ]; then
  return 0
fi

PM2_API="$SITE-api"
PM2_ADMIN_API="$SITE-admin-api"
PM2_WORKER="$SITE-worker"

echo "========================================="
echo "  Chumbaq - First-Time Setup ($DEPLOY_ENV)"
echo "========================================="

# Before anything is written: the names go into the .env and the nginx config.
check_server_names
# And the log retention (CERT-In: never under 180 days), from the environment or the .env.
check_log_retention_days "${LOG_RETENTION_DAYS:-$( [ -f "$APP_DIR/.env" ] && env_file_value "$APP_DIR/.env" LOG_RETENTION_DAYS )}" > /dev/null

# On a server with a file baseline already: what changed since it is raised now, or the
# new baseline taken at the end of this run would hide it (as deploy-update.sh does).
check_files_before_deploy

# --- System packages ---
echo "[1/8] Installing system packages..."
# Upgrades keep config files this script has changed (nginx.conf, redis.conf, chrony.conf)
# instead of stopping to ask, which over SSH with nobody to answer would hang the run.
printf 'Dpkg::Options {\n  "--force-confdef";\n  "--force-confold";\n};\n' |
  sys_write "$(R /etc/apt/apt.conf.d/90chumbaq-keep-config)"
sudo apt update && sudo apt upgrade -y
sudo apt install -y build-essential git curl ca-certificates nginx \
  postgresql postgresql-contrib redis-server certbot python3-certbot-nginx acl
sudo systemctl enable postgresql
sudo systemctl start postgresql

echo "[2/8] Installing Node.js and PM2..."
install_node
if ! command -v pm2 > /dev/null; then
  sudo npm install -g pm2
fi

echo "[3/8] Getting the code..."
ensure_checkout

# --- Create .env ---
# Before the build: apps/web bakes VITE_ADMIN_APP_URL in, and refuses to build without it.
echo "[4/8] Creating .env and the database..."
choose_redis_password
if [ ! -f "$APP_DIR/.env" ]; then
  write_env_template "$APP_DIR/.env"
  echo "  Wrote $APP_DIR/.env with generated secrets. Back up MFA_ENCRYPTION_KEY and"
  echo "  CREDENTIALS_ENCRYPTION_KEY somewhere other than this server."
else
  echo ".env already exists, skipping..."
  # Stops here, before the build and nginx, if the .env names another admin host.
  ensure_admin_app_urls "$APP_DIR/.env"
fi
ensure_redis_settings "$APP_DIR/.env"
setup_database

# --- CERT-In: clock, log retention, nginx log format, alarms, log collector; Redis ---
echo "[5/8] Setting up the clock, log retention, security alarms and Redis..."
if server_wide; then
  setup_server_security "$APP_DIR/.env"
else
  echo "  The clock, log retention, alarms and log collector are the server's; they are set up"
  echo "  with DEPLOY_ENV=prod, so $DEPLOY_ENV skips them."
fi
setup_redis "$APP_DIR/.env"

# --- Install dependencies & build ---
echo "[6/8] Installing dependencies and building..."
cd "$APP_DIR"
npm ci
npm run build:shared
npm run build:api
npm run build:web
npm run build:admin

# --- Nginx config ---
echo "[7/8] Configuring Nginx..."
allow_nginx_traverse
write_site chumbaq-default default_site_config
write_site "$SITE" customer_site_config
write_site "$SITE-admin" admin_site_config

enable_site chumbaq-default
enable_site "$SITE"
enable_site "$SITE-admin"
sudo rm -f "$NGINX_ENABLED/default"
sudo nginx -t && sudo systemctl restart nginx
sudo systemctl enable nginx

# --- Start with PM2 ---
# ecosystem.config.cjs: every log line with an ISO 8601 time. The customer API first: it
# applies migrations at boot, and the admin API and the worker never change the schema.
echo "[8/8] Starting the API, admin API and worker..."
pm2_up api
wait_for_health "$API_PORT"
pm2_up admin-api
pm2_up worker
wait_for_health "$ADMIN_API_PORT"
pm2 save
pm2 startup systemd -u "$(id -un)" --hp "$HOME" | tail -1 | sudo bash

# Last, once everything is installed: what the daily file check compares with.
echo "Taking the file baseline for the daily check (a few minutes)..."
update_file_baseline

echo ""
echo "========================================="
echo "  Setup Complete! ($DEPLOY_ENV)"
echo "========================================="
echo ""
echo "  Dashboard and API: http://$APP_SERVER_NAME    Admin: http://$ADMIN_SERVER_NAME"
echo "  pm2: $PM2_API, $PM2_ADMIN_API, $PM2_WORKER    Database: $DB_NAME    Redis DB: $REDIS_DB"
echo ""
echo "  Next steps:"
echo "  1. With both names pointing at this server, add HTTPS (the sign-in cookies are Secure):"
echo "       sudo certbot --nginx -d $APP_SERVER_NAME -d $ADMIN_SERVER_NAME"
echo "     Running this script again afterwards leaves those sites as certbot left them."
echo "     It looks for TLS in the site files themselves only: TLS set up through an"
echo "     include is yours to keep, and is replaced if the site file has none of its own."
echo "  2. Once HTTPS works on $ADMIN_SERVER_NAME, add HSTS to its 443 server block in"
echo "     $NGINX_SITES/$SITE-admin, then: sudo nginx -t && sudo systemctl reload nginx"
echo "       add_header Strict-Transport-Security \"max-age=31536000\" always;"
echo "  3. For each super admin, an operator runs (from $APP_DIR/apps/api):"
echo "       npm run admin:grant -- <email>            (once, for a new one)"
echo "       npm run admin:staff-enrolment -- <email>"
echo "     It prints a one-time enrolment code, good for 24 hours. Give it to them yourself,"
echo "     not by email. They enter it with their password at https://$ADMIN_SERVER_NAME"
echo "     to add a staff passkey or authenticator app."
echo "  4. Optional: account email. Set PLATFORM_BREVO_API_KEY and PLATFORM_EMAIL_FROM in"
echo "     $APP_DIR/.env, then: pm2 restart $PM2_API $PM2_ADMIN_API $PM2_WORKER --update-env"
echo ""
echo "  5. CERT-In (prod): in the admin app's Incidents page, save the security contact"
echo "     (organisation and point of contact) used by the report draft, and set"
echo "     SECURITY_CONTACT in .env to publish /.well-known/security.txt. Logs for a window:"
echo "       sudo chumbaq-collect-logs --from <ISO time> --to <ISO time>"
echo ""
echo "  Updates: DEPLOY_ENV=$DEPLOY_ENV $APP_DIR/scripts/deploy-update.sh [branch]"
echo "  Useful:  pm2 status | pm2 logs $PM2_API | pm2 monit | chronyc sources"
echo ""
