#!/usr/bin/env bash
#
# QA Integration Test Script — In-App Banners (Widgets) Module
# Requires: running API on localhost:3000 with PostgreSQL
#
# Usage:
#   chmod +x scripts/qa-test-widgets.sh
#   ./scripts/qa-test-widgets.sh
#
set -euo pipefail

BASE="http://localhost:3000/api"
PASS=0
FAIL=0
TOTAL=0

green() { printf "\033[32m%s\033[0m\n" "$1"; }
red()   { printf "\033[31m%s\033[0m\n" "$1"; }
bold()  { printf "\033[1m%s\033[0m\n" "$1"; }

assert_status() {
  local label="$1" expected="$2" actual="$3"
  TOTAL=$((TOTAL + 1))
  if [ "$actual" = "$expected" ]; then
    green "  PASS [$label] → HTTP $actual"
    PASS=$((PASS + 1))
  else
    red "  FAIL [$label] → expected $expected, got $actual"
    FAIL=$((FAIL + 1))
  fi
}

assert_json_field() {
  local label="$1" body="$2" field="$3" expected="$4"
  TOTAL=$((TOTAL + 1))
  local value
  value=$(echo "$body" | jq -r "$field" 2>/dev/null || echo "PARSE_ERROR")
  if [ "$value" = "$expected" ]; then
    green "  PASS [$label] → $field = $value"
    PASS=$((PASS + 1))
  else
    red "  FAIL [$label] → $field expected '$expected', got '$value'"
    FAIL=$((FAIL + 1))
  fi
}

# ──────────────────────────────────────────────────────────────
bold "═══ QA Test Suite: In-App Banners Module ═══"
bold ""
bold "Phase 1: Auth & Project Setup"
# ──────────────────────────────────────────────────────────────

# Register
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/auth/register" \
  -H "Content-Type: application/json" \
  -d '{"email":"qa-widgets@test.io","password":"QaTest123!","name":"QA Tester"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')

if [ "$HTTP" = "201" ]; then
  assert_status "Register user" "201" "$HTTP"
elif [ "$HTTP" = "409" ]; then
  # Already exists, login instead
  echo "  INFO: User already exists, logging in..."
fi

# Login
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email":"qa-widgets@test.io","password":"QaTest123!"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Login" "200" "$HTTP"

TOKEN=$(echo "$BODY" | jq -r '.data.accessToken // .accessToken // empty')
if [ -z "$TOKEN" ]; then
  red "FATAL: Could not extract JWT token. Response: $BODY"
  exit 1
fi
green "  Got JWT token: ${TOKEN:0:20}..."

AUTH="Authorization: Bearer $TOKEN"

# Create project
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/projects" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"name":"QA Widget Test","domain":"qa-widget.example.com"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Create project" "201" "$HTTP"

PROJECT_ID=$(echo "$BODY" | jq -r '.data.id // .id // empty')
if [ -z "$PROJECT_ID" ]; then
  red "FATAL: Could not extract project ID. Response: $BODY"
  exit 1
fi
green "  Project ID: $PROJECT_ID"

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 2: Banner Category CRUD"
# ──────────────────────────────────────────────────────────────

# Create banner category
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/projects/$PROJECT_ID/banner-categories" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"name":"Hero Carousel","layout":"carousel","description":"Homepage hero banners","autoRotate":true,"rotationInterval":5}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Create category" "201" "$HTTP"

CATEGORY_ID=$(echo "$BODY" | jq -r '.data.id // .id // empty')
if [ -z "$CATEGORY_ID" ]; then
  red "FATAL: Could not extract category ID. Response: $BODY"
  exit 1
fi
green "  Category ID: $CATEGORY_ID"

# Verify default status is 'draft'
assert_json_field "Default status=draft" "$BODY" '.data.status // .status' "draft"

# List categories
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/projects/$PROJECT_ID/banner-categories" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "List categories" "200" "$HTTP"

# List with layout filter
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/projects/$PROJECT_ID/banner-categories?layout=carousel" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "List categories (filter layout=carousel)" "200" "$HTTP"

# Get single category (with banners relation)
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Get category by ID" "200" "$HTTP"

# Update category
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"name":"Hero Carousel Updated","backgroundColor":"#f0f0f0","padding":8}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Update category" "200" "$HTTP"
assert_json_field "Updated name" "$BODY" '.data.name // .name' "Hero Carousel Updated"

# Update status to active
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID/status" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"status":"active"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Update status → active" "200" "$HTTP"
assert_json_field "Status is active" "$BODY" '.data.status // .status' "active"

# Update status to paused
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID/status" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"status":"paused"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Update status → paused" "200" "$HTTP"
assert_json_field "Status is paused" "$BODY" '.data.status // .status' "paused"

# Invalid status
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID/status" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"status":"archived"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Invalid status rejected" "403" "$HTTP"

# Set back to active for serve test
curl -s -X PATCH "$BASE/banner-categories/$CATEGORY_ID/status" \
  -H "Content-Type: application/json" -H "$AUTH" -d '{"status":"active"}' > /dev/null

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 3: Banner CRUD"
# ──────────────────────────────────────────────────────────────

# Create banner 1
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"Summer Sale","imageUrl":"https://example.com/summer.jpg","clickUrl":"https://example.com/summer","ctaText":"Shop Now","sortOrder":0}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Create banner 1" "201" "$HTTP"

BANNER1_ID=$(echo "$BODY" | jq -r '.data.id // .id // empty')
green "  Banner 1 ID: $BANNER1_ID"

# Create banner 2
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"Winter Collection","imageUrl":"https://example.com/winter.jpg","clickUrl":"https://example.com/winter","ctaText":"Browse","sortOrder":1}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Create banner 2" "201" "$HTTP"

BANNER2_ID=$(echo "$BODY" | jq -r '.data.id // .id // empty')
green "  Banner 2 ID: $BANNER2_ID"

# Create banner 3 (with scheduling)
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"title\":\"Flash Deal\",\"imageUrl\":\"https://example.com/flash.jpg\",\"clickUrl\":\"https://example.com/flash\",\"sortOrder\":2,\"startsAt\":\"2026-03-01T00:00:00Z\",\"expiresAt\":\"2026-12-31T23:59:59Z\"}")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Create banner 3 (scheduled)" "201" "$HTTP"

BANNER3_ID=$(echo "$BODY" | jq -r '.data.id // .id // empty')

# List banners
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "List banners" "200" "$HTTP"

# Get single banner
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/in-app-banners/$BANNER1_ID" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Get single banner" "200" "$HTTP"
assert_json_field "Banner title" "$BODY" '.data.title // .title' "Summer Sale"

# Update banner
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/in-app-banners/$BANNER1_ID" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"Summer Sale 2026","ctaText":"Buy Now"}')
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Update banner" "200" "$HTTP"
assert_json_field "Updated title" "$BODY" '.data.title // .title' "Summer Sale 2026"

# Reorder banners
RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID/banners/reorder" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d "{\"items\":[{\"id\":\"$BANNER2_ID\",\"sortOrder\":0},{\"id\":\"$BANNER1_ID\",\"sortOrder\":1},{\"id\":\"$BANNER3_ID\",\"sortOrder\":2}]}")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Reorder banners" "200" "$HTTP"

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 4: Public Endpoints (Serve & Click)"
# ──────────────────────────────────────────────────────────────

# Serve widget (no auth required)
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/in-app-banners/serve/$CATEGORY_ID" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X) Chrome/120.0" \
  -H "Referer: https://myapp.example.com/home")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Serve widget (public, no auth)" "200" "$HTTP"

# Check category is returned
assert_json_field "Served category name" "$BODY" '.data.category.name // .category.name' "Hero Carousel Updated"

# Record click (no auth required)
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/in-app-banners/$BANNER1_ID/click" \
  -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/605.1" \
  -H "Referer: https://myapp.example.com/home")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Record click (public, no auth)" "200" "$HTTP"

# Record a few more clicks for analytics
for i in $(seq 1 3); do
  curl -s -X POST "$BASE/in-app-banners/$BANNER2_ID/click" \
    -H "User-Agent: Mozilla/5.0 (Linux; Android 14) Chrome/120.0" > /dev/null
done
green "  Recorded 3 additional clicks on banner 2"

# Serve again to generate more impressions
curl -s "$BASE/in-app-banners/serve/$CATEGORY_ID" \
  -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/121.0" > /dev/null
green "  Generated additional impressions"

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 5: Analytics Endpoints"
# ──────────────────────────────────────────────────────────────

# Summary
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
BODY=$(echo "$RESP" | sed '$d')
assert_status "Analytics summary" "200" "$HTTP"

# Timeseries (default: last 30 days, daily)
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics/timeseries" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics timeseries (default)" "200" "$HTTP"

# Timeseries with params
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics/timeseries?start=2026-03-01&end=2026-03-31&granularity=hour" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics timeseries (hourly, date range)" "200" "$HTTP"

# Device breakdown
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics/devices" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics device breakdown" "200" "$HTTP"

# Geo breakdown
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics/geo" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics geo breakdown" "200" "$HTTP"

# Item stats
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics/items" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics item stats" "200" "$HTTP"

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 6: Validation & Error Cases"
# ──────────────────────────────────────────────────────────────

# Create category without required name
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/projects/$PROJECT_ID/banner-categories" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"description":"No name"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Reject category without name" "400" "$HTTP"

# Create banner without required fields
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"No URL"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Reject banner without imageUrl/clickUrl" "400" "$HTTP"

# Create banner with invalid URL
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"Bad","imageUrl":"not-a-url","clickUrl":"also-bad"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Reject banner with invalid URLs" "400" "$HTTP"

# Access without auth
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/$CATEGORY_ID/analytics")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Analytics without auth → 401" "401" "$HTTP"

RESP=$(curl -s -w "\n%{http_code}" -X PATCH "$BASE/banner-categories/$CATEGORY_ID" \
  -H "Content-Type: application/json" \
  -d '{"name":"Hacked"}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Update without auth → 401" "401" "$HTTP"

# Non-existent category
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/00000000-0000-0000-0000-000000000000" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Non-existent category → 404" "404" "$HTTP"

# Non-existent banner
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/in-app-banners/00000000-0000-0000-0000-000000000000" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Non-existent banner → 404" "404" "$HTTP"

# Serve non-active category
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/in-app-banners/serve/00000000-0000-0000-0000-000000000000")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Serve non-existent widget → 404" "404" "$HTTP"

# Invalid UUID
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/banner-categories/not-a-uuid" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Invalid UUID → 400" "400" "$HTTP"

# Forbidden fields (non-whitelisted)
RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/banner-categories/$CATEGORY_ID/banners" \
  -H "Content-Type: application/json" \
  -H "$AUTH" \
  -d '{"title":"Hack","imageUrl":"https://example.com/a.jpg","clickUrl":"https://example.com/b","impressions":999999}')
HTTP=$(echo "$RESP" | tail -1)
assert_status "Reject non-whitelisted field (impressions)" "400" "$HTTP"

# ──────────────────────────────────────────────────────────────
bold ""
bold "Phase 7: Cleanup"
# ──────────────────────────────────────────────────────────────

# Delete banner
RESP=$(curl -s -w "\n%{http_code}" -X DELETE "$BASE/in-app-banners/$BANNER1_ID" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Delete banner" "200" "$HTTP"

# Delete category (cascades)
RESP=$(curl -s -w "\n%{http_code}" -X DELETE "$BASE/banner-categories/$CATEGORY_ID" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Delete category (cascade)" "200" "$HTTP"

# Verify cascade deletion
RESP=$(curl -s -w "\n%{http_code}" -X GET "$BASE/in-app-banners/$BANNER2_ID" \
  -H "$AUTH")
HTTP=$(echo "$RESP" | tail -1)
assert_status "Cascaded banner gone → 404" "404" "$HTTP"

# ──────────────────────────────────────────────────────────────
bold ""
bold "═══════════════════════════════════════════"
bold "  QA Results: $PASS/$TOTAL passed, $FAIL failed"
bold "═══════════════════════════════════════════"

if [ "$FAIL" -gt 0 ]; then
  red "  Some tests failed!"
  exit 1
else
  green "  All tests passed!"
  exit 0
fi
