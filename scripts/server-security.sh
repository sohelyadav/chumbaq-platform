#!/bin/bash
# =============================================================
# Chumbaq - the CERT-In pieces of a server, sourced by deploy-setup.sh and
# deploy-update.sh (CERT-In directions of 28 April 2022):
#   - every log kept LOG_RETENTION_DAYS (default 365, never under 180), rotated daily
#   - the clock synced to NIC and NPL (chrony), or NTP_SERVERS
#   - nginx access logs in one format with no query strings and no path secrets
#   - /.well-known/security.txt when SECURITY_CONTACT is set
#   - server alarms: every SSH login, fail2ban bans, AIDE's daily file check
#   - the log bundle collector, installed root-owned
#
# The functions that print config are tested by apps/api/src/config/server-security.spec.ts;
# the setup_* functions write it, through sudo, and run only from the deploy scripts.
# =============================================================

SERVER_SECURITY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LOG_RETENTION_FLOOR_DAYS=180
LOG_RETENTION_DEFAULT_DAYS=365
DEFAULT_NTP_SERVERS="samay1.nic.in samay2.nic.in time.nplindia.org"

# $1 = the value as set (may be empty). Prints the days to keep, or stops below the floor.
check_log_retention_days() {
  local value="${1:-}"
  value="${value//[[:space:]]/}"
  if [ -z "$value" ]; then
    echo "$LOG_RETENTION_DEFAULT_DAYS"
    return 0
  fi
  if ! [[ $value =~ ^[0-9]+$ ]]; then
    echo "LOG_RETENTION_DAYS must be a whole number of days, not \"$1\"" >&2
    return 1
  fi
  if [ "$value" -lt "$LOG_RETENTION_FLOOR_DAYS" ]; then
    echo "LOG_RETENTION_DAYS must be at least $LOG_RETENTION_FLOOR_DAYS (CERT-In requires 180 days of logs), not $value" >&2
    return 1
  fi
  echo "$value"
}

# The distribution's logrotate files that chumbaq-retention replaces (moved aside, not
# deleted: logrotate refuses two rules for one file).
replaced_logrotate_files() {
  printf '%s\n' nginx rsyslog postgresql-common redis-server fail2ban chrony
}

# $1 = days. One rule per program, each keeping how that program reopens its log.
# dpkg and apt keep 12 monthly files already (a year); journald is not the record.
logrotate_rules() {
  local days="$1"
  local common="    daily
    rotate $days
    maxage $days
    dateext
    dateformat -%Y%m%d
    compress
    delaycompress
    missingok
    notifempty"
  cat << EOF
# Written by Chumbaq's deploy scripts (scripts/server-security.sh). CERT-In: keep logs
# for a rolling 180 days at least; these keep $days. Change LOG_RETENTION_DAYS, not this file.

/var/log/nginx/*.log {
$common
    create 0640 www-data adm
    sharedscripts
    postrotate
        invoke-rc.d nginx rotate >/dev/null 2>&1 || true
    endscript
}

/var/log/syslog
/var/log/mail.log
/var/log/kern.log
/var/log/auth.log
/var/log/user.log
/var/log/cron.log
{
$common
    sharedscripts
    postrotate
        /usr/lib/rsyslog/rsyslog-rotate
    endscript
}

/var/log/postgresql/*.log {
$common
    copytruncate
    su root adm
}

/var/log/redis/*.log {
$common
    copytruncate
}

/var/log/chrony/*.log {
$common
    sharedscripts
    postrotate
        /usr/bin/chronyc cyclelogs > /dev/null 2>&1 || true
    endscript
}

/var/log/fail2ban.log {
$common
    create 0640 root adm
    postrotate
        fail2ban-client flushlogs 1>/dev/null || true
    endscript
}
EOF
}

# $1 = NTP_SERVERS (space separated host names), empty for NIC and NPL.
chrony_conf() {
  local servers="${1:-$DEFAULT_NTP_SERVERS}" host
  [ -n "${servers// /}" ] || servers="$DEFAULT_NTP_SERVERS"
  echo "# Written by Chumbaq's deploy scripts. CERT-In: sync to NIC or NPL (or a source traceable to them)."
  for host in $servers; do
    if ! [[ $host =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]; then
      echo "NTP_SERVERS: '$host' is not a host name" >&2
      return 1
    fi
    echo "server $host iburst"
  done
  cat << 'EOF'
makestep 1 3
log tracking measurements statistics
logdir /var/log/chrony
EOF
}

# $1 = NTP_SERVERS (empty for NIC and NPL), $2 = a `chronyc -c tracking` line. True when
# chrony's selected source is one of the configured servers (not, say, a DHCP-supplied one).
clock_source_ok() {
  local servers="${1:-$DEFAULT_NTP_SERVERS}" name host
  [ -n "${servers// /}" ] || servers="$DEFAULT_NTP_SERVERS"
  name=$(printf '%s' "$2" | cut -d, -f2)
  [ -n "$name" ] || return 1
  for host in $servers; do
    [ "$host" = "$name" ] && return 0
  done
  return 1
}

# The http-level nginx snippet (/etc/nginx/conf.d/chumbaq-logging.conf). Every server
# inherits the access log, so it covers sites certbot has edited too. The path is logged
# without its query string (reset tokens, view-as codes, campaign parameters), provider
# webhook secrets in the path are masked, and only the referrer's host is kept.
nginx_logging_conf() {
  cat << 'EOF'
# Written by Chumbaq's deploy scripts (scripts/server-security.sh).
map $uri $chumbaq_log_path {
    ~^(/api/(email|sms|whatsapp)/webhooks/[^/]+/)[^/]+(.*)$ $1:token$3;
    default $uri;
}
map $http_referer $chumbaq_referer_host {
    ~^[a-z][a-z0-9+.-]*://([^/?#]+) $1;
    default -;
}
log_format chumbaq escape=json '$time_iso8601 $remote_addr $request_id '
    '"$request_method $chumbaq_log_path $server_protocol" $status $body_bytes_sent '
    '$request_time "$chumbaq_referer_host" "$http_user_agent"';
access_log /var/log/nginx/access.log chumbaq;
# Error lines quote the request line, query string and path secrets included; critical
# errors (nginx itself failing) are the ones that do not.
error_log /var/log/nginx/error.log crit;
EOF
}

# $1 = SECURITY_CONTACT (an email or an https URL), $2 = Expires (RFC 3339).
security_txt() {
  local contact="$1" expires="$2"
  if [[ $contact == *$'\n'* ]] || ! [[ $contact =~ ^([^[:space:]@]+@[A-Za-z0-9.-]+|https://[^[:space:]]+)$ ]]; then
    echo "SECURITY_CONTACT must be an email address or an https URL" >&2
    return 1
  fi
  [[ $contact == https://* ]] || contact="mailto:$contact"
  printf 'Contact: %s\nExpires: %s\nPreferred-Languages: en\n' "$contact" "$expires"
}

# /usr/local/sbin/chumbaq-security-alert <kind> <key> [name=value ...]: posts a server
# alarm to the admin API on this machine (never through nginx) and to syslog.
alert_script() {
  cat << 'EOF'
#!/bin/bash
# Raises a Chumbaq security alarm from a server script. Written by the deploy scripts.
#   chumbaq-security-alert <kind> <key> [name=value ...]
kind="$1"; key="$2"; shift 2 || exit 0
json_string() {
  local s="$1"
  s="${s//\\/\\\\}"; s="${s//\"/\\\"}"; s="${s//$'\n'/\\n}"; s="${s//$'\r'/}"; s="${s//$'\t'/ }"
  printf '"%s"' "$s"
}
details=""
for pair in "$@"; do
  name="${pair%%=*}"; value="${pair#*=}"
  [ -n "$details" ] && details="$details,"
  details="$details$(json_string "$name"):$(json_string "$value")"
done
body="{\"kind\":$(json_string "$kind"),\"key\":$(json_string "$key"),\"details\":{$details}}"
logger -t chumbaq-security "$kind $key $*" 2>/dev/null || true
token_file="${ALERT_TOKEN_FILE:-/etc/chumbaq/alert-token}"
[ -r "$token_file" ] || exit 0
curl -fsS --max-time 5 -X POST \
  -H 'content-type: application/json' \
  -H "x-security-alert-token: $(tr -d '\n' < "$token_file")" \
  --data-binary "$body" \
  "http://127.0.0.1:${ADMIN_API_PORT:-3011}/api/internal/security-alerts" > /dev/null 2>&1 || true
exit 0
EOF
}

# pam_exec on sshd: every SSH login is an alarm. In the background, and always exit 0,
# so a login is never slowed or refused because of it.
ssh_login_alert_script() {
  cat << 'EOF'
#!/bin/bash
# Called by pam_exec for sshd sessions. Written by Chumbaq's deploy scripts.
if [ "${PAM_TYPE:-}" = "open_session" ]; then
  /usr/local/sbin/chumbaq-security-alert server.ssh_login "${PAM_USER:-unknown}@${PAM_RHOST:-unknown}" \
    "user=${PAM_USER:-unknown}" "from=${PAM_RHOST:-unknown}" "tty=${PAM_TTY:-}" > /dev/null 2>&1 &
fi
exit 0
EOF
}

fail2ban_jail() {
  cat << 'EOF'
# Written by Chumbaq's deploy scripts.
[sshd]
enabled = true
maxretry = 5
findtime = 10m
bantime = 1h
action = %(action_)s
         chumbaq-alert
EOF
}

fail2ban_action() {
  cat << 'EOF'
# Written by Chumbaq's deploy scripts: a fail2ban ban is a security alarm.
[Definition]
actionban = /usr/local/sbin/chumbaq-security-alert server.ssh_banned <ip> ip=<ip> jail=<name>
actionunban =
EOF
}

# /etc/cron.daily/chumbaq-aide: AIDE compares the system with the baseline taken after
# the last deploy; any change is an alarm naming the first 20 paths.
aide_check_script() {
  cat << 'EOF'
#!/bin/bash
# Written by Chumbaq's deploy scripts. Daily: files changed since the last deploy.
report=$(aide --check --config /etc/aide/aide.conf 2>&1)
[ $? -eq 0 ] && exit 0
paths=$(printf '%s\n' "$report" | grep -E '^[fdlbcps][^:]*: /' | sed 's/^[^:]*: //' | head -20 | tr '\n' ' ')
/usr/local/sbin/chumbaq-security-alert server.files_changed "$(date -u +%Y-%m-%d)" "paths=${paths:-see aide --check}"
exit 0
EOF
}

# $1 = file, $2 = name: the value the .env's last line for it sets ('' if none).
env_file_value() {
  local line
  line=$(grep -E "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1" 2>/dev/null | tail -1) || true
  [ -n "$line" ] || return 0
  line="${line%$'\r'}"
  line=$(printf '%s' "$line" | sed -E 's/^[[:space:]]*(export[[:space:]]+)?[A-Za-z0-9_.-]+[[:space:]]*[=:][[:space:]]*//')
  line="${line%\"}"; line="${line#\"}"; line="${line%\'}"; line="${line#\'}"
  printf '%s' "$line"
}

# $1 = .env file, $2 = name, $3 = value: appended only when the .env has no line for it.
env_add_if_missing() {
  if ! grep -Eq "^[[:space:]]*(export[[:space:]]+)?$2[[:space:]]*[=:]" "$1"; then
    printf '%s=%s\n' "$2" "$3" >> "$1"
    echo "  Added $2 to $1"
  fi
}

# ---- Writers (deploy scripts only; each is safe to run again) ----
# Every system path below is under ${SYSTEM_ROOT:-} (empty on a server), so the
# whole-script test in deploy-setup.spec.ts writes into a scratch directory instead.
R() { printf '%s%s' "${SYSTEM_ROOT:-}" "$1"; }

# $1 = file: sudo tee into it, making its directory first.
sys_write() {
  sudo mkdir -p "$(dirname "$1")"
  sudo tee "$1" > /dev/null
}

# $1 = file: sudo tee -a onto it, making its directory first.
sys_append() {
  sudo mkdir -p "$(dirname "$1")"
  sudo tee -a "$1" > /dev/null
}

# $1 = .env. Redis on localhost with a password; the API, admin API and worker use it.
setup_redis() {
  local env="$1" password conf
  conf=$(R /etc/redis/redis.conf)
  sudo apt install -y redis-server
  env_add_if_missing "$env" REDIS_HOST 127.0.0.1
  env_add_if_missing "$env" REDIS_PORT 6379
  env_add_if_missing "$env" REDIS_PASSWORD "$(openssl rand -hex 32)"
  password=$(env_file_value "$env" REDIS_PASSWORD)
  sudo sed -i -E 's/^#?[[:space:]]*bind .*/bind 127.0.0.1 -::1/' "$conf"
  sudo sed -i -E '/^#?[[:space:]]*requirepass /d' "$conf"
  printf 'requirepass %s\n' "$password" | sys_append "$conf"
  sudo systemctl enable redis-server
  sudo systemctl restart redis-server
}

# $1 = days. Logs kept $1 days, the distribution's rules moved aside.
setup_log_retention() {
  local days="$1" name
  sudo mkdir -p "$(R /etc/chumbaq/logrotate-originals)"
  for name in $(replaced_logrotate_files); do
    if [ -f "$(R /etc/logrotate.d/"$name")" ]; then
      sudo mv "$(R /etc/logrotate.d/"$name")" "$(R /etc/chumbaq/logrotate-originals/"$name")"
    fi
  done
  logrotate_rules "$days" | sys_write "$(R /etc/logrotate.d/chumbaq-retention)"
  if ! sudo logrotate --debug "$(R /etc/logrotate.conf)" > /dev/null 2>&1; then
    echo "logrotate refused the new rules; see: sudo logrotate --debug /etc/logrotate.conf" >&2
    return 1
  fi
  pm2 install pm2-logrotate > /dev/null
  pm2 set pm2-logrotate:retain "$days" > /dev/null
  pm2 set pm2-logrotate:compress true > /dev/null
  pm2 set pm2-logrotate:rotateInterval '0 0 * * *' > /dev/null
  pm2 set pm2-logrotate:dateFormat YYYYMMDD > /dev/null
  # By day only: a second rotation the same day would overwrite that day's file.
  pm2 set pm2-logrotate:max_size 100G > /dev/null
}

# $1 = NTP_SERVERS. Waits up to 60 seconds for a source, else stops.
setup_clock() {
  local conf
  conf=$(chrony_conf "$1") || return 1
  sudo apt install -y chrony
  sudo mkdir -p "$(R /var/log/chrony)"
  # Only our servers: no distribution pool, and no sources handed out by DHCP or dropped in
  # sources.d (a cloud's own time server is not NIC or NPL).
  sudo sed -i -E 's/^(pool[[:space:]]|sourcedir[[:space:]])/#\1/' "$(R /etc/chrony/chrony.conf)"
  printf '%s\n' "$conf" | sys_write "$(R /etc/chrony/conf.d/chumbaq.conf)"
  sudo systemctl enable chrony
  sudo systemctl restart chrony
  for _ in $(seq 1 30); do
    if clock_source_ok "$1" "$(chronyc -c tracking 2>/dev/null)"; then
      chronyc sources
      return 0
    fi
    sleep 2
  done
  echo "The clock is not synced to one of its configured servers after 60 seconds. Check: chronyc sources (servers: ${1:-$DEFAULT_NTP_SERVERS})" >&2
  return 1
}

# $1 = SECURITY_CONTACT (may be empty: then nothing is served).
setup_nginx_logging() {
  local contact="$1"
  nginx_logging_conf | sys_write "$(R /etc/nginx/conf.d/chumbaq-logging.conf)"
  # The distribution's own access_log line logs full request lines (query strings too).
  sudo sed -i -E 's/^([[:space:]]*)access_log[[:space:]]+\/var\/log\/nginx\/access\.log;/\1# access_log \/var\/log\/nginx\/access.log; # replaced by conf.d\/chumbaq-logging.conf/' "$(R /etc/nginx/nginx.conf)"
  if [ -n "$contact" ]; then
    security_txt "$contact" "$(date -u -d '+1 year' +%Y-%m-%dT00:00:00Z)" | sys_write "$(R /etc/chumbaq/security.txt)"
  else
    sudo rm -f "$(R /etc/chumbaq/security.txt)"
  fi
}

# $1 = .env. The alarm scripts, the root-only token copy, pam_exec, fail2ban and AIDE.
setup_server_alarms() {
  local env="$1" pam
  env_add_if_missing "$env" SECURITY_ALERT_TOKEN "$(openssl rand -hex 32)"
  env_file_value "$env" SECURITY_ALERT_TOKEN | sys_write "$(R /etc/chumbaq/alert-token)"
  sudo chmod 0600 "$(R /etc/chumbaq/alert-token)"
  alert_script | sys_write "$(R /usr/local/sbin/chumbaq-security-alert)"
  ssh_login_alert_script | sys_write "$(R /usr/local/sbin/chumbaq-ssh-login-alert)"
  sudo chmod 0755 "$(R /usr/local/sbin/chumbaq-security-alert)" "$(R /usr/local/sbin/chumbaq-ssh-login-alert)"
  pam=$(R /etc/pam.d/sshd)
  if ! sudo grep -q chumbaq-ssh-login-alert "$pam" 2>/dev/null; then
    echo 'session optional pam_exec.so quiet /usr/local/sbin/chumbaq-ssh-login-alert' | sys_append "$pam"
  fi
  sudo apt install -y fail2ban aide
  fail2ban_action | sys_write "$(R /etc/fail2ban/action.d/chumbaq-alert.conf)"
  fail2ban_jail | sys_write "$(R /etc/fail2ban/jail.d/chumbaq.conf)"
  sudo systemctl enable fail2ban
  sudo systemctl restart fail2ban
  aide_check_script | sys_write "$(R /etc/cron.daily/chumbaq-aide)"
  sudo chmod 0755 "$(R /etc/cron.daily/chumbaq-aide)"
}

# The log bundle collector, root-owned, so root never runs code the app user can write.
install_log_collector() {
  sudo mkdir -p "$(R /usr/local/lib/chumbaq)" "$(R /usr/local/sbin)" "$(R /var/lib/chumbaq/log-bundles)"
  sudo chmod 0700 "$(R /var/lib/chumbaq/log-bundles)"
  sudo install -o root -g root -m 0644 "$SERVER_SECURITY_DIR/collect-logs.mjs" "$(R /usr/local/lib/chumbaq/collect-logs.mjs)"
  sudo install -o root -g root -m 0755 "$SERVER_SECURITY_DIR/collect-logs.sh" "$(R /usr/local/sbin/chumbaq-collect-logs)"
}

# Before a deploy changes anything: what changed since the last baseline is raised now, or
# the new baseline taken after the deploy would hide it.
check_files_before_deploy() {
  if [ -x "$(R /etc/cron.daily/chumbaq-aide)" ] && [ -f "$(R /var/lib/aide/aide.db)" ]; then
    sudo "$(R /etc/cron.daily/chumbaq-aide)" || true
  fi
}

# After a deploy: the file baseline becomes what was just deployed (taking it the first
# time takes a few minutes).
refresh_file_baseline() {
  if [ -f "$(R /var/lib/aide/aide.db)" ]; then
    sudo aide --update --config /etc/aide/aide.conf > /dev/null 2>&1 || true
    sudo cp "$(R /var/lib/aide/aide.db.new)" "$(R /var/lib/aide/aide.db)"
  else
    sudo aideinit -y -f > /dev/null
  fi
}

# $1 = .env. Everything above, in order; stops on the first refusal.
setup_server_security() {
  local env="$1" days
  days=$(check_log_retention_days "${LOG_RETENTION_DAYS:-$(env_file_value "$env" LOG_RETENTION_DAYS)}") || return 1
  setup_clock "${NTP_SERVERS:-$(env_file_value "$env" NTP_SERVERS)}"
  setup_nginx_logging "${SECURITY_CONTACT:-$(env_file_value "$env" SECURITY_CONTACT)}"
  setup_server_alarms "$env"
  install_log_collector
  # Last of these, after every package that ships its own rotation rule (chrony, fail2ban;
  # redis-server comes with setup_redis, which the deploy scripts run separately, just
  # before the processes reload, so live ones never meet a Redis with a new password).
  sudo apt install -y redis-server
  setup_log_retention "$days"
}
