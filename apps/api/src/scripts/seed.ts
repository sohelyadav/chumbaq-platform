import * as path from 'path';
import { config as loadEnv } from 'dotenv';

// The same repo-root .env the API uses, so the seed drops and fills the database
// the app is configured for, never the default name.
loadEnv({ path: path.resolve(__dirname, '../../../../.env') });
import { AdminAuditLogEntity } from '../modules/admin/entities/admin-audit-log.entity';
import { DataSource } from 'typeorm';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

// ── Production guard ──
// This script DROPS THE DATABASE. Refuse to run in production, full stop.
if (process.env.NODE_ENV === 'production') {
  console.error('✗ Refusing to run seed script with NODE_ENV=production');
  process.exit(1);
}
const seedHost = process.env.DATABASE_HOST || 'localhost';
if (seedHost !== 'localhost' && seedHost !== '127.0.0.1' && !process.env.CHUMBAQ_SEED_ALLOW_REMOTE) {
  console.error(
    `✗ Refusing to seed against non-local DATABASE_HOST=${seedHost}. ` +
      `Set CHUMBAQ_SEED_ALLOW_REMOTE=1 to override (only do this if you really mean it).`,
  );
  process.exit(1);
}
import { UserEntity } from '../modules/users/entities/user.entity';
import { ProjectEntity } from '../modules/projects/entities/project.entity';
import { LinkEntity } from '../modules/links/entities/link.entity';
import { ClickEventEntity } from '../modules/analytics/entities/click-event.entity';
import { ConversionEventEntity } from '../modules/conversions/entities/conversion-event.entity';
import { TeamEntity } from '../modules/teams/entities/team.entity';
import { TeamMemberEntity } from '../modules/teams/entities/team-member.entity';
import { ApiKeyEntity } from '../modules/api-keys/entities/api-key.entity';
import { WebhookEntity } from '../modules/webhooks/entities/webhook.entity';
import {
  generateWebhookSecret,
  sealWebhookSecret,
  webhookSecretHint,
} from '../modules/webhooks/webhook-secret';
import { CredentialsCryptoService } from '../common/credentials-crypto.service';
import { ConfigService } from '@nestjs/config';

import { BannerCategoryEntity } from '../modules/in-app-banners/entities/banner-category.entity';
import { InAppBannerEntity } from '../modules/in-app-banners/entities/in-app-banner.entity';
import { WidgetEventEntity } from '../modules/in-app-banners/entities/widget-event.entity';
import { LinkVariantEntity } from '../modules/links/entities/link-variant.entity';
import { DeviceIdentityEntity } from '../modules/identity/entities/device-identity.entity';
import { PushTokenEntity } from '../modules/push-tokens/entities/push-token.entity';
import { PushConfigEntity } from '../modules/push-notifications/entities/push-config.entity';
import { PushNotificationLogEntity } from '../modules/push-notifications/entities/push-notification-log.entity';
import { InAppMessageEntity } from '../modules/in-app-messages/entities/in-app-message.entity';
import { InAppMessageImpressionEntity } from '../modules/in-app-messages/entities/in-app-message-impression.entity';
import { PendingMessageEntity } from '../modules/in-app-messages/entities/pending-message.entity';
import { MixpanelConfigEntity } from '../modules/mixpanel-cohorts/entities/mixpanel-config.entity';
import { MixpanelCohortEntity } from '../modules/mixpanel-cohorts/entities/mixpanel-cohort.entity';
import { MixpanelCohortMemberEntity } from '../modules/mixpanel-cohorts/entities/mixpanel-cohort-member.entity';
import { TouchpointEntity } from '../modules/touchpoints/entities/touchpoint.entity';
import { UserEventEntity } from '../modules/events/entities/user-event.entity';
import { AttributionResultEntity } from '../modules/attribution/entities/attribution-result.entity';

// ── Constants ──
const PROJECT_ID = 'e8600afc-f4a8-4b79-ade2-64491611c32d';

// ── Helpers ──
function randomFrom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}
function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function randomDate(daysBack: number): Date {
  return new Date(Date.now() - Math.random() * daysBack * 86400000);
}
function futureDate(daysAhead: number): Date {
  return new Date(Date.now() + Math.random() * daysAhead * 86400000);
}
function shortCode(): string {
  const c = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 7 }, () => c[Math.floor(Math.random() * c.length)]).join('');
}
function uuid(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
function fp(): string {
  return `fp_${Math.random().toString(36).substring(2, 15)}${Math.random().toString(36).substring(2, 8)}`;
}
function ip(): string {
  return `${randomInt(10, 220)}.${randomInt(1, 254)}.${randomInt(1, 254)}.${randomInt(1, 254)}`;
}
/** Deterministic picsum URL using image IDs 1-1084 */
function pic(w: number, h: number, id?: number): string {
  const imgId = id ?? randomInt(1, 800);
  return `https://picsum.photos/id/${imgId}/${w}/${h}`;
}

// ── Lookup Data ──
const PLATFORMS = ['web', 'ios', 'android'];
const DEVICE_TYPES = ['mobile', 'desktop', 'tablet'];
const OSES = ['iOS', 'Android', 'Windows', 'macOS', 'Linux'];
const BROWSERS = ['Chrome', 'Safari', 'Firefox', 'Edge', 'Samsung Internet'];
const REDIRECT_TYPES = ['web_fallback', 'app_deeplink', 'app_store', 'play_store'];
const COUNTRIES = [
  { name: 'India', code: 'IN', cities: ['Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai', 'Pune'], tz: 'Asia/Kolkata' },
  { name: 'United States', code: 'US', cities: ['New York', 'San Francisco', 'Los Angeles', 'Chicago', 'Austin', 'Seattle'], tz: 'America/New_York' },
  { name: 'United Kingdom', code: 'GB', cities: ['London', 'Manchester', 'Birmingham', 'Edinburgh'], tz: 'Europe/London' },
  { name: 'Germany', code: 'DE', cities: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt'], tz: 'Europe/Berlin' },
  { name: 'Japan', code: 'JP', cities: ['Tokyo', 'Osaka', 'Kyoto', 'Yokohama'], tz: 'Asia/Tokyo' },
  { name: 'Canada', code: 'CA', cities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary'], tz: 'America/Toronto' },
  { name: 'Australia', code: 'AU', cities: ['Sydney', 'Melbourne', 'Brisbane', 'Perth'], tz: 'Australia/Sydney' },
  { name: 'France', code: 'FR', cities: ['Paris', 'Lyon', 'Marseille', 'Toulouse'], tz: 'Europe/Paris' },
  { name: 'Brazil', code: 'BR', cities: ['São Paulo', 'Rio de Janeiro', 'Brasília'], tz: 'America/Sao_Paulo' },
  { name: 'Singapore', code: 'SG', cities: ['Singapore'], tz: 'Asia/Singapore' },
  { name: 'UAE', code: 'AE', cities: ['Dubai', 'Abu Dhabi', 'Sharjah'], tz: 'Asia/Dubai' },
];
const REFERRERS = [
  'https://google.com', 'https://twitter.com', 'https://facebook.com',
  'https://linkedin.com', 'https://reddit.com', 'https://producthunt.com',
  'https://instagram.com', 'https://youtube.com', 'https://tiktok.com',
  'https://medium.com', 'https://dev.to', null, null, null,
];
const EVENT_TYPES = ['signup', 'purchase', 'add_to_cart', 'install', 'subscription', 'upgrade', 'first_deposit', 'checkout_started'];
const USER_AGENTS = [
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.6261.64 Mobile Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Linux; Android 14; Samsung Galaxy S24) AppleWebKit/537.36 SamsungBrowser/24.0 Chrome/122.0.0.0 Mobile Safari/537.36',
  'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Mobile/15E148 Safari/604.1',
];
const FIRST_NAMES = ['Aarav', 'Vivaan', 'Kabir', 'Aditya', 'Diya', 'Ananya', 'Priya', 'Rahul', 'Emma', 'James', 'Olivia', 'Liam', 'Yuki', 'Haruto', 'Sophia', 'Alexander', 'Maria', 'Carlos', 'Li', 'Wei', 'Marcus', 'Nina', 'Fatima', 'Omar', 'Lena'];
const LAST_NAMES = ['Yadav', 'Sharma', 'Patel', 'Kumar', 'Smith', 'Johnson', 'Williams', 'Tanaka', 'Müller', 'Garcia', 'Chen', 'Wang', 'Silva', 'Ahmed', 'Kim', 'Singh', 'Brown', 'Lee', 'Martin', 'Ali', 'Das', 'Gupta', 'Roy', 'Khan', 'Wilson'];
const DEVICES = [
  { manufacturer: 'Apple', brand: 'Apple', model: 'iPhone 15 Pro', os: 'iOS', platform: 'ios', sw: 1179, sh: 2556 },
  { manufacturer: 'Apple', brand: 'Apple', model: 'iPhone 14', os: 'iOS', platform: 'ios', sw: 1170, sh: 2532 },
  { manufacturer: 'Apple', brand: 'Apple', model: 'iPad Pro 11"', os: 'iPadOS', platform: 'ios', sw: 2388, sh: 1668 },
  { manufacturer: 'Samsung', brand: 'Samsung', model: 'Galaxy S24 Ultra', os: 'Android', platform: 'android', sw: 1440, sh: 3120 },
  { manufacturer: 'Samsung', brand: 'Samsung', model: 'Galaxy A54', os: 'Android', platform: 'android', sw: 1080, sh: 2340 },
  { manufacturer: 'Google', brand: 'Google', model: 'Pixel 8 Pro', os: 'Android', platform: 'android', sw: 1344, sh: 2992 },
  { manufacturer: 'OnePlus', brand: 'OnePlus', model: 'OnePlus 12', os: 'Android', platform: 'android', sw: 1440, sh: 3168 },
  { manufacturer: 'Xiaomi', brand: 'Xiaomi', model: 'Redmi Note 13 Pro', os: 'Android', platform: 'android', sw: 1220, sh: 2712 },
  { manufacturer: null, brand: null, model: null, os: 'macOS', platform: 'web', sw: 2560, sh: 1440 },
  { manufacturer: null, brand: null, model: null, os: 'Windows', platform: 'web', sw: 1920, sh: 1080 },
  { manufacturer: null, brand: null, model: null, os: 'Linux', platform: 'web', sw: 1920, sh: 1080 },
];
const SDK_EVENTS = [
  'app_open', 'app_close', 'screen_view', 'button_click', 'signup_started', 'signup_completed',
  'login', 'logout', 'profile_updated', 'search_performed', 'item_viewed', 'item_added_to_cart',
  'checkout_started', 'purchase_completed', 'share_link', 'notification_received', 'notification_opened',
  'onboarding_step_1', 'onboarding_step_2', 'onboarding_step_3', 'onboarding_completed',
  'tutorial_started', 'tutorial_completed', 'feedback_submitted', 'rating_submitted',
  'payment_method_added', 'subscription_started', 'subscription_renewed', 'subscription_cancelled',
  'referral_sent', 'referral_accepted', 'deep_link_opened',
];
const CHANNELS = ['organic_search', 'paid_search', 'social_media', 'email', 'direct', 'referral', 'display_ads', 'push_notification'];
const UTM_SOURCES = ['google', 'facebook', 'twitter', 'linkedin', 'instagram', 'newsletter', 'partner-blog', 'producthunt'];
const UTM_MEDIUMS = ['cpc', 'organic', 'social', 'email', 'banner', 'referral', 'affiliate'];
const UTM_CAMPAIGNS = [
  'spring_launch_2026', 'brand_awareness_q1', 'retargeting_apr', 'product_launch',
  'webinar_growth', 'black_friday_2026', 'new_year_sale', 'referral_program',
  'influencer_collab', 'app_install_campaign',
];

// ── Links ──
const LINKS = [
  { title: 'Download App', longUrl: 'https://chumbaq.com/download', tags: ['marketing', 'app'], iosUrl: 'chumbaq://home', androidUrl: 'chumbaq://home' },
  { title: 'Onboarding Flow', longUrl: 'https://chumbaq.com/onboarding', tags: ['onboarding'], iosUrl: 'chumbaq://onboarding', androidUrl: 'chumbaq://onboarding' },
  { title: 'Referral Link', longUrl: 'https://chumbaq.com/refer', tags: ['referral', 'growth'] },
  { title: 'Feature Announcement', longUrl: 'https://chumbaq.com/blog/new-features', tags: ['blog', 'announcement'] },
  { title: 'Support Page', longUrl: 'https://chumbaq.com/support', tags: ['support'] },
  { title: 'Pricing Page', longUrl: 'https://chumbaq.com/pricing', tags: ['marketing'] },
  { title: 'SDK Integration Guide', longUrl: 'https://chumbaq.com/docs/sdk', tags: ['docs', 'developer'] },
  { title: 'Partnership Program', longUrl: 'https://chumbaq.com/partners', tags: ['partnerships', 'b2b'] },
  { title: 'Mobile Deep Link Demo', longUrl: 'https://chumbaq.com/demo', tags: ['demo', 'sales'], iosUrl: 'chumbaq://demo', androidUrl: 'chumbaq://demo' },
  { title: 'Year End Campaign 2026', longUrl: 'https://chumbaq.com/campaign/year-end-2026', tags: ['campaign', 'seasonal'] },
  { title: 'Summer Sale', longUrl: 'https://chumbaq.com/sale/summer', tags: ['sale', 'summer'], iosUrl: 'chumbaq://sale/summer', androidUrl: 'chumbaq://sale/summer' },
  { title: 'Product Launch – Sneakers', longUrl: 'https://chumbaq.com/products/sneakers-pro', tags: ['product', 'launch'] },
  { title: 'Flash Deal', longUrl: 'https://chumbaq.com/deals/flash', tags: ['deals'] },
  { title: 'Gift Cards', longUrl: 'https://chumbaq.com/gift-cards', tags: ['gift'] },
  { title: 'Loyalty Program', longUrl: 'https://chumbaq.com/loyalty', tags: ['loyalty', 'retention'] },
  { title: 'Winter Collection', longUrl: 'https://chumbaq.com/collections/winter-2026', tags: ['collection', 'winter'], iosUrl: 'chumbaq://collection/winter', androidUrl: 'chumbaq://collection/winter' },
  { title: 'Free Shipping Promo', longUrl: 'https://chumbaq.com/promo/free-shipping', tags: ['promo', 'shipping'] },
  { title: 'VIP Early Access', longUrl: 'https://chumbaq.com/vip-access', tags: ['vip', 'exclusive'] },
  { title: 'Blog – SEO Tips', longUrl: 'https://chumbaq.com/blog/seo-tips-2026', tags: ['blog', 'seo'] },
  { title: 'Webinar Registration', longUrl: 'https://chumbaq.com/webinar/growth-hacking', tags: ['webinar', 'event'] },
  { title: 'Case Study – Acme Corp', longUrl: 'https://chumbaq.com/case-studies/acme', tags: ['case-study'] },
  { title: 'Newsletter Signup', longUrl: 'https://chumbaq.com/newsletter', tags: ['newsletter'] },
  { title: 'Podcast Episode #42', longUrl: 'https://chumbaq.com/podcast/ep-42', tags: ['podcast', 'content'] },
  { title: 'Product Hunt Launch', longUrl: 'https://chumbaq.com/launch', tags: ['launch', 'product-hunt'] },
  { title: 'LinkedIn Ad Campaign', longUrl: 'https://chumbaq.com/lp/linkedin-2026', tags: ['linkedin', 'ads'] },
  { title: 'Google Ads Landing', longUrl: 'https://chumbaq.com/lp/google', tags: ['google', 'ads'] },
  { title: 'KYC Verification', longUrl: 'https://chumbaq.com/kyc', tags: ['kyc', 'compliance'], iosUrl: 'chumbaq://kyc', androidUrl: 'chumbaq://kyc' },
  { title: 'Referral Rewards', longUrl: 'https://chumbaq.com/refer-earn', tags: ['referral', 'rewards'] },
  { title: 'Investment Plans', longUrl: 'https://chumbaq.com/invest/plans', tags: ['investment', 'plans'] },
  { title: 'Cashback Offer', longUrl: 'https://chumbaq.com/offers/cashback', tags: ['offers', 'cashback'] },
  { title: 'Credit Score Check', longUrl: 'https://chumbaq.com/credit-score', tags: ['credit', 'finance'] },
  { title: 'Insurance Landing', longUrl: 'https://chumbaq.com/insurance', tags: ['insurance', 'cross-sell'] },
  { title: 'Black Friday Deals', longUrl: 'https://chumbaq.com/black-friday', tags: ['sale', 'seasonal', 'black-friday'] },
  { title: 'Customer Reviews', longUrl: 'https://chumbaq.com/reviews', tags: ['reviews', 'social-proof'] },
  { title: 'App Feedback Form', longUrl: 'https://chumbaq.com/feedback', tags: ['feedback', 'nps'] },
];

// ════════════════════════════════════════════════════
// ██  SEED FUNCTION
// ════════════════════════════════════════════════════
async function seed() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DATABASE_HOST || 'localhost',
    port: parseInt(process.env.DATABASE_PORT || '5432', 10),
    username: process.env.DATABASE_USER || 'chumbaq',
    password: process.env.DATABASE_PASSWORD || 'secret',
    database: process.env.DATABASE_NAME || 'chumbaq',
    // Every entity, so the schema matches what the API builds (new tables included).
    entities: [path.join(__dirname, '..', '**', '*.entity.{ts,js}')],
    synchronize: true,
  });

  await ds.initialize();
  console.log('✦ Connected to database');

  console.log('✦ Dropping all tables...');
  await ds.dropDatabase();
  console.log('✦ Synchronizing schema...');
  await ds.synchronize();
  console.log('✦ Schema created\n');

  // ──────────────────────────────────────────────────
  //  1. USERS
  // ──────────────────────────────────────────────────
  console.log('1. Seeding users…');
  const userRepo = ds.getRepository(UserEntity);
  const USERS = [
    // Local demo accounts only (this script refuses NODE_ENV=production).
    { email: 'admin@example.com', name: 'Demo Admin', password: 'admin123', isSuperAdmin: true },
    { email: 'dev@example.com', name: 'Demo Developer', password: 'dev123' },
    { email: 'marketing@example.com', name: 'Demo Marketer', password: 'marketing123' },
    { email: 'product@example.com', name: 'Demo Product Manager', password: 'product123' },
  ];
  const users: UserEntity[] = [];
  for (const u of USERS) {
    const hash = await bcrypt.hash(u.password, 10);
    users.push(await userRepo.save(userRepo.create({ email: u.email, name: u.name, passwordHash: hash, isSuperAdmin: u.isSuperAdmin ?? false })));
    console.log(`   ✓ ${u.email} / ${u.password}`);
  }
  const admin = users[0];

  // ──────────────────────────────────────────────────
  //  2. PROJECT (single)
  // ──────────────────────────────────────────────────
  console.log('\n2. Seeding project…');
  const projRepo = ds.getRepository(ProjectEntity);
  const project = await projRepo.save(projRepo.create({
    id: PROJECT_ID,
    name: 'Chumbaq Mobile',
    domain: 'chumbaq.com',
    iosBundleId: 'com.chumbaq.app',
    iosAppStoreUrl: 'https://apps.apple.com/app/chumbaq/id123456789',
    iosTeamId: 'ABCD1234',
    androidPackageName: 'com.chumbaq.app',
    androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.chumbaq.app',
    webFallbackUrl: 'https://chumbaq.com',
    ownerId: admin.id,
  } as any)) as any as ProjectEntity;
  await ds.query(
    `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner') ON CONFLICT DO NOTHING`,
    [project.id, admin.id],
  );
  console.log(`   ✓ ${project.name} (${project.id})`);

  // ──────────────────────────────────────────────────
  //  3. LINKS (35)
  // ──────────────────────────────────────────────────
  console.log('\n3. Seeding links…');
  const linkRepo = ds.getRepository(LinkEntity);
  const allLinks: LinkEntity[] = [];
  for (const l of LINKS) {
    const saved = await linkRepo.save(linkRepo.create({
      shortCode: shortCode(),
      longUrl: l.longUrl,
      title: l.title,
      tags: l.tags,
      iosUrl: (l as any).iosUrl || undefined,
      androidUrl: (l as any).androidUrl || undefined,
      projectId: project.id,
      isActive: true,
      ogTitle: l.title,
      ogDescription: `Check out ${l.title} on Chumbaq`,
      ogImage: pic(1200, 630, randomInt(1, 200)),
    } as any));
    allLinks.push(Array.isArray(saved) ? saved[0] : saved);
  }
  console.log(`   ✓ ${allLinks.length} links`);

  // ──────────────────────────────────────────────────
  //  4. LINK VARIANTS (A/B tests)
  // ──────────────────────────────────────────────────
  console.log('\n4. Seeding link variants…');
  const varRepo = ds.getRepository(LinkVariantEntity);
  let varCount = 0;
  for (let i = 0; i < allLinks.length; i += 3) {
    const link = allLinks[i];
    for (const v of [
      { name: 'Control', longUrl: link.longUrl, weight: 50, clicks: randomInt(40, 200), conversions: randomInt(5, 30) },
      { name: 'Variant B – Urgency CTA', longUrl: link.longUrl + '?v=b', weight: 50, clicks: randomInt(40, 200), conversions: randomInt(5, 30) },
    ]) {
      await varRepo.save(varRepo.create({ ...v, linkId: link.id, iosUrl: null, androidUrl: null } as any));
      varCount++;
    }
  }
  console.log(`   ✓ ${varCount} link variants`);

  // ──────────────────────────────────────────────────
  //  5. DEVICE IDENTITIES (60)
  // ──────────────────────────────────────────────────
  console.log('\n5. Seeding device identities…');
  const devRepo = ds.getRepository(DeviceIdentityEntity);
  const savedDevices: DeviceIdentityEntity[] = [];
  const DEVICE_COUNT = 60;
  for (let i = 0; i < DEVICE_COUNT; i++) {
    const d = randomFrom(DEVICES);
    const co = randomFrom(COUNTRIES);
    const fn = randomFrom(FIRST_NAMES);
    const ln = randomFrom(LAST_NAMES);
    const extId = Math.random() > 0.25 ? `usr_${i + 1000}` : null;
    const distinctIdVal = extId || `anon_${fp()}`;

    const saved = await devRepo.save(devRepo.create({
      projectId: project.id,
      externalUserId: extId,
      distinctId: distinctIdVal,
      deviceFingerprint: fp(),
      platform: d.platform,
      userAgent: randomFrom(USER_AGENTS),
      ipAddress: ip(),
      traits: { plan: randomFrom(['free', 'pro', 'enterprise']), signupSource: randomFrom(['organic', 'referral', 'ad', 'social']) },
      firstName: fn,
      lastName: ln,
      phone: Math.random() > 0.4 ? `+${randomInt(1, 91)}${randomInt(7000000000, 9999999999)}` : null,
      avatar: `https://i.pravatar.cc/150?u=${i}`,
      locale: randomFrom(['en_US', 'en_IN', 'de_DE', 'ja_JP', 'fr_FR', 'pt_BR']),
      language: randomFrom(['en', 'hi', 'de', 'ja', 'fr', 'pt']),
      os: d.os, osVersion: `${randomInt(14, 18)}.${randomInt(0, 5)}`,
      browser: d.platform === 'web' ? randomFrom(BROWSERS) : null,
      browserVersion: d.platform === 'web' ? `${randomInt(100, 124)}.0.${randomInt(0, 9999)}` : null,
      appVersion: d.platform !== 'web' ? `${randomInt(2, 5)}.${randomInt(0, 12)}.${randomInt(0, 9)}` : null,
      appBuild: d.platform !== 'web' ? `${randomInt(100, 500)}` : null,
      manufacturer: d.manufacturer, brand: d.brand, model: d.model,
      screenWidth: d.sw, screenHeight: d.sh,
      carrier: d.platform !== 'web' ? randomFrom(['Jio', 'Airtel', 'Verizon', 'AT&T', 'Vodafone', 'T-Mobile', null]) : null,
      country: co.name, countryCode: co.code, region: randomFrom(co.cities), city: randomFrom(co.cities), timezone: co.tz,
      latitude: randomInt(-33, 55) + Math.random(), longitude: randomInt(-120, 140) + Math.random(),
      initialReferrer: randomFrom(REFERRERS), initialReferringDomain: randomFrom(['google.com', 'facebook.com', 'twitter.com', null]),
      initialUtmSource: randomFrom([...UTM_SOURCES, null, null]), initialUtmMedium: randomFrom([...UTM_MEDIUMS, null, null]),
      initialUtmCampaign: randomFrom([...UTM_CAMPAIGNS, null, null]),
      latestReferrer: randomFrom(REFERRERS), latestUtmSource: randomFrom([...UTM_SOURCES, null]),
      latestUtmMedium: randomFrom([...UTM_MEDIUMS, null]), latestUtmCampaign: randomFrom([...UTM_CAMPAIGNS, null]),
      totalSessions: randomInt(1, 150), totalRevenue: parseFloat((Math.random() * 500).toFixed(2)),
      lastEventAt: randomDate(7), currency: randomFrom(['USD', 'INR', 'EUR', 'GBP', 'JPY']),
      emailOptIn: Math.random() > 0.3, smsOptIn: Math.random() > 0.6,
      pushOptIn: Math.random() > 0.25, gdprConsent: Math.random() > 0.1, doNotTrack: Math.random() > 0.9,
    } as any));
    savedDevices.push(Array.isArray(saved) ? saved[0] : saved);
  }
  console.log(`   ✓ ${DEVICE_COUNT} device identities`);

  // ──────────────────────────────────────────────────
  //  6. CLICK EVENTS (600)
  // ──────────────────────────────────────────────────
  console.log('\n6. Seeding click events…');
  const clickRepo = ds.getRepository(ClickEventEntity);
  const clicks: Partial<ClickEventEntity>[] = [];
  for (let i = 0; i < 600; i++) {
    const co = randomFrom(COUNTRIES);
    clicks.push({
      linkId: randomFrom(allLinks).id,
      clickedAt: randomDate(60),
      ipAddress: ip(), userAgent: randomFrom(USER_AGENTS),
      referrer: randomFrom(REFERRERS) || undefined,
      platform: randomFrom(PLATFORMS), deviceType: randomFrom(DEVICE_TYPES),
      os: randomFrom(OSES), osVersion: `${randomInt(14, 18)}.${randomInt(0, 5)}`,
      browser: randomFrom(BROWSERS), browserVersion: `${randomInt(100, 124)}.0`,
      country: co.name, countryCode: co.code, city: randomFrom(co.cities), region: randomFrom(co.cities),
      latitude: 20 + Math.random() * 40, longitude: -120 + Math.random() * 200,
      redirectType: randomFrom(REDIRECT_TYPES),
      isDeferred: Math.random() > 0.9, matched: Math.random() > 0.3,
    });
  }
  await clickRepo.save(clicks as any[]);
  console.log('   ✓ 600 click events');

  // ──────────────────────────────────────────────────
  //  7. CONVERSIONS (100)
  // ──────────────────────────────────────────────────
  console.log('\n7. Seeding conversions…');
  const convRepo = ds.getRepository(ConversionEventEntity);
  const savedConvs: ConversionEventEntity[] = [];
  const convBatch: any[] = [];
  for (let i = 0; i < 100; i++) {
    const dev = Math.random() > 0.25 ? randomFrom(savedDevices) : null;
    convBatch.push({
      linkId: randomFrom(allLinks).id,
      eventType: randomFrom(EVENT_TYPES),
      convertedAt: randomDate(30),
      metadata: { source: 'seed', revenue: parseFloat((Math.random() * 200).toFixed(2)), currency: randomFrom(['USD', 'INR', 'EUR']) },
      deviceIdentityId: dev?.id || undefined,
      distinctId: dev?.distinctId || undefined,
    });
  }
  const convResult = await convRepo.save(convBatch);
  savedConvs.push(...(Array.isArray(convResult) ? convResult : [convResult]));
  console.log('   ✓ 100 conversion events');

  // ──────────────────────────────────────────────────
  //  8. TEAMS (3)
  // ──────────────────────────────────────────────────
  console.log('\n8. Seeding teams…');
  const teamRepo = ds.getRepository(TeamEntity);
  const memRepo = ds.getRepository(TeamMemberEntity);
  const teams = [
    { name: 'Core Team', description: 'Main development and marketing team', ownerId: admin.id },
    { name: 'Growth Squad', description: 'Focused on user acquisition and retention', ownerId: admin.id },
    { name: 'Product Team', description: 'Product development and feature planning', ownerId: users[3].id },
  ];
  const savedTeams: TeamEntity[] = [];
  for (const t of teams) savedTeams.push(await teamRepo.save(teamRepo.create(t)));
  await memRepo.save([
    memRepo.create({ teamId: savedTeams[0].id, userId: users[0].id, role: 'owner' as any }),
    memRepo.create({ teamId: savedTeams[0].id, userId: users[1].id, role: 'member' as any }),
    memRepo.create({ teamId: savedTeams[0].id, userId: users[2].id, role: 'member' as any }),
    memRepo.create({ teamId: savedTeams[0].id, userId: users[3].id, role: 'member' as any }),
    memRepo.create({ teamId: savedTeams[1].id, userId: users[0].id, role: 'owner' as any }),
    memRepo.create({ teamId: savedTeams[1].id, userId: users[2].id, role: 'member' as any }),
    memRepo.create({ teamId: savedTeams[2].id, userId: users[3].id, role: 'owner' as any }),
    memRepo.create({ teamId: savedTeams[2].id, userId: users[1].id, role: 'member' as any }),
  ]);
  console.log('   ✓ 3 teams, 8 members');

  // ──────────────────────────────────────────────────
  //  9. API KEYS (2)
  // ──────────────────────────────────────────────────
  console.log('\n9. Seeding API keys…');
  const akRepo = ds.getRepository(ApiKeyEntity);
  for (const k of [
    { name: 'Chumbaq – Production', prefix: 'dk_live_' },
    { name: 'Chumbaq – Staging',    prefix: 'dk_test_' },
  ]) {
    const kh = await bcrypt.hash(`${k.prefix}chumbaq_mobile_key`, 10);
    await akRepo.save(akRepo.create({ projectId: project.id, name: k.name, keyHash: kh, prefix: k.prefix, permissions: ['read', 'write'], isActive: true }));
  }
  console.log('   ✓ 2 API keys');

  // ──────────────────────────────────────────────────
  //  10. WEBHOOKS (4)
  // ──────────────────────────────────────────────────
  console.log('\n10. Seeding webhooks…');
  const whRepo = ds.getRepository(WebhookEntity);
  const webhooks = [
    { url: 'https://hooks.chumbaq.com/events', events: ['click', 'conversion', 'link.created'], isActive: true },
    { url: 'https://zapier.com/hooks/catch/12345/chumbaq', events: ['click', 'conversion'], isActive: true },
    { url: 'https://slack.com/api/webhook/chumbaq-alerts', events: ['conversion'], isActive: true },
    { url: 'https://api.segment.io/v1/webhook', events: ['click', 'conversion', 'link.created', 'link.updated'], isActive: false },
  ];
  // Secrets are stored encrypted, so seeding them needs the app's key. Without
  // it the step is skipped rather than writing rows the API could never sign with.
  let webhooksSeeded = 0;
  if (process.env.CREDENTIALS_ENCRYPTION_KEY) {
    const credentialsCrypto = new CredentialsCryptoService({
      get: (key: string) => process.env[key],
    } as unknown as ConfigService);
    for (const w of webhooks) {
      const secret = generateWebhookSecret();
      await whRepo.save(
        whRepo.create({
          ...w,
          projectId: project.id,
          secretSealed: sealWebhookSecret(credentialsCrypto, secret),
          secretHint: webhookSecretHint(secret),
        }),
      );
      webhooksSeeded++;
    }
    console.log(`   ✓ ${webhooksSeeded} webhooks`);
  } else {
    console.log('   ✗ webhooks skipped: CREDENTIALS_ENCRYPTION_KEY is not set');
  }

  // ──────────────────────────────────────────────────
  //  11. BANNER CATEGORIES & BANNERS  (picsum images)
  // ──────────────────────────────────────────────────
  console.log('\n11. Seeding in-app banner categories & banners…');
  const catRepo = ds.getRepository(BannerCategoryEntity);
  const bannerRepo = ds.getRepository(InAppBannerEntity);

  const catData = [
    { name: 'Hero Banners', layout: 'carousel', aspectRatio: '16:9', status: 'active' },
    { name: 'Promo Carousel', layout: 'carousel', aspectRatio: '4:3', status: 'active' },
    { name: 'Onboarding Tips', layout: 'carousel', aspectRatio: '16:9', status: 'active' },
    { name: 'Flash Sales', layout: 'carousel', aspectRatio: '2:1', status: 'active' },
    { name: 'Product Spotlight', layout: 'carousel', aspectRatio: '1:1', status: 'active' },
    { name: 'Seasonal Offers', layout: 'carousel', aspectRatio: '16:9', status: 'active' },
    // Single Format (Banners)
    { name: 'Homepage Top Banners', layout: 'single', aspectRatio: '16:9', status: 'active' }, // 6
    { name: 'Checkout Promo Banner', layout: 'single', aspectRatio: '21:9', status: 'active' }, // 7
    // Stories
    { name: 'Latest Updates', layout: 'stories', aspectRatio: '9:16', status: 'active' }, // 8
    { name: 'Creator Spotlight', layout: 'stories', aspectRatio: '9:16', status: 'active' }, // 9
  ];
  const savedCats: BannerCategoryEntity[] = [];
  for (const c of catData) savedCats.push(await catRepo.save(catRepo.create({ ...c, projectId: project.id })));

  const bannerData = [
    // Hero Banners
    { catIdx: 0, title: 'Welcome to Chumbaq', imgId: 0, clickUrl: 'https://chumbaq.com/welcome', w: 1200, h: 675 },
    { catIdx: 0, title: 'New Features – Spring 2026', imgId: 1, clickUrl: 'https://chumbaq.com/features', w: 1200, h: 675 },
    { catIdx: 0, title: 'SDK v5.0 Released', imgId: 10, clickUrl: 'https://chumbaq.com/sdk/v5', w: 1200, h: 675 },
    // Promo Carousel
    { catIdx: 1, title: 'Pro Plan – 50% Off', imgId: 20, clickUrl: 'https://chumbaq.com/pricing', w: 800, h: 600 },
    { catIdx: 1, title: 'Invite & Earn Credits', imgId: 24, clickUrl: 'https://chumbaq.com/referral', w: 800, h: 600 },
    { catIdx: 1, title: 'Enterprise Demo', imgId: 28, clickUrl: 'https://chumbaq.com/enterprise', w: 800, h: 600 },
    // Onboarding Tips
    { catIdx: 2, title: 'Create Your First Link', imgId: 42, clickUrl: 'chumbaq://onboarding/step1', w: 1200, h: 675 },
    { catIdx: 2, title: 'Setup Deep Linking', imgId: 48, clickUrl: 'chumbaq://onboarding/step2', w: 1200, h: 675 },
    { catIdx: 2, title: 'Track Analytics', imgId: 49, clickUrl: 'chumbaq://onboarding/step3', w: 1200, h: 675 },
    // Flash Sales
    { catIdx: 3, title: 'Summer Flash Sale – 70% Off', imgId: 60, clickUrl: 'https://chumbaq.com/flash-sale', w: 1200, h: 600 },
    { catIdx: 3, title: 'Limited Edition Drop', imgId: 64, clickUrl: 'https://chumbaq.com/limited', w: 1200, h: 600 },
    // Product Spotlight
    { catIdx: 4, title: 'Trending: Link Analytics', imgId: 100, clickUrl: 'https://chumbaq.com/analytics', w: 600, h: 600 },
    { catIdx: 4, title: 'Best Feature: Smart Redirects', imgId: 101, clickUrl: 'https://chumbaq.com/smart-redirects', w: 600, h: 600 },
    { catIdx: 4, title: 'New: Team Collaboration', imgId: 103, clickUrl: 'https://chumbaq.com/teams', w: 600, h: 600 },
    // Seasonal Offers
    { catIdx: 5, title: 'Earn 12% APY Credits', imgId: 110, clickUrl: 'https://chumbaq.com/credits', w: 1200, h: 675 },
    { catIdx: 5, title: 'Zero Fee Month', imgId: 119, clickUrl: 'https://chumbaq.com/zero-fee', w: 1200, h: 675 },
    // Single Format (Banners)
    { catIdx: 6, title: 'Join our Community', imgId: 200, clickUrl: 'https://chumbaq.com/community', w: 1200, h: 675 },
    { catIdx: 6, title: 'Webinar Registration', imgId: 201, clickUrl: 'https://chumbaq.com/webinar', w: 1200, h: 675 },
    { catIdx: 7, title: 'Get 20% Off', imgId: 210, clickUrl: 'https://chumbaq.com/checkout', w: 1000, h: 428 },
    { catIdx: 7, title: 'Free Shipping', imgId: 211, clickUrl: 'https://chumbaq.com/shipping', w: 1000, h: 428 },
    // Stories Format
    { catIdx: 8, title: 'Story: New Insights', imgId: 300, clickUrl: 'https://chumbaq.com/insights', w: 1080, h: 1920 },
    { catIdx: 8, title: 'Story: A/B Testing', imgId: 301, clickUrl: 'https://chumbaq.com/ab', w: 1080, h: 1920 },
    { catIdx: 8, title: 'Story: User Metrics', imgId: 302, clickUrl: 'https://chumbaq.com/metrics', w: 1080, h: 1920 },
    { catIdx: 9, title: 'Creator: Jane Do', imgId: 310, clickUrl: 'https://chumbaq.com/jane', w: 1080, h: 1920 },
    { catIdx: 9, title: 'Creator: John Ray', imgId: 311, clickUrl: 'https://chumbaq.com/john', w: 1080, h: 1920 },
    { catIdx: 9, title: 'Creator: Alice Q', imgId: 312, clickUrl: 'https://chumbaq.com/alice', w: 1080, h: 1920 },
  ];
  const savedBanners: InAppBannerEntity[] = [];
  for (let i = 0; i < bannerData.length; i++) {
    const b = bannerData[i];
    const saved = await bannerRepo.save(bannerRepo.create({
      categoryId: savedCats[b.catIdx].id,
      title: b.title,
      imageUrl: pic(b.w, b.h, b.imgId),
      clickUrl: b.clickUrl,
      sortOrder: i,
      isActive: true,
    })) as any as InAppBannerEntity;
    savedBanners.push(saved);
  }
  console.log(`   ✓ ${catData.length} categories, ${bannerData.length} banners`);

  // ──────────────────────────────────────────────────
  //  12. PUSH TOKENS (from devices)
  // ──────────────────────────────────────────────────
  console.log('\n12. Seeding push tokens…');
  const ptRepo = ds.getRepository(PushTokenEntity);
  let tokenCount = 0;
  for (const dev of savedDevices) {
    if (dev.platform === 'web') continue;
    if (Math.random() > 0.15) {
      await ptRepo.save(ptRepo.create({
        projectId: project.id, deviceIdentityId: dev.id,
        token: `fcm_${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}${Math.random().toString(36).substring(2)}`,
        platform: dev.platform as any, provider: 'fcm', isActive: Math.random() > 0.1, lastUsedAt: randomDate(14),
      }));
      tokenCount++;
    }
  }
  console.log(`   ✓ ${tokenCount} push tokens`);

  // ──────────────────────────────────────────────────
  //  13. PUSH NOTIFICATION LOGS (12)
  // ──────────────────────────────────────────────────
  console.log('\n13. Seeding push notification logs…');
  const pnlRepo = ds.getRepository(PushNotificationLogEntity);
  const pushLogs = [
    { title: 'Welcome to Chumbaq! 🚀', body: 'Start creating deep links that drive 3x more conversions.', totalTokens: 156, successCount: 148, failureCount: 8, status: 'partial' as any },
    { title: 'New Feature: A/B Testing', body: 'Split test your links and track what converts best.', totalTokens: 203, successCount: 203, failureCount: 0, status: 'sent' as any },
    { title: 'Your Weekly Analytics Report', body: 'You had 1,247 clicks this week. See your top links →', totalTokens: 189, successCount: 185, failureCount: 4, status: 'partial' as any },
    { title: '🔥 Flash Sale Ending Tonight!', body: 'Up to 70% off. Don\'t miss out!', totalTokens: 342, successCount: 342, failureCount: 0, status: 'sent' as any },
    { title: 'Your Cart is Waiting 🛒', body: 'You have 3 items in your cart. Complete checkout now!', totalTokens: 89, successCount: 87, failureCount: 2, status: 'partial' as any },
    { title: 'Exclusive VIP Early Access', body: 'New winter collection is live for VIP members only.', totalTokens: 45, successCount: 45, failureCount: 0, status: 'sent' as any },
    { title: 'Complete Your KYC ✅', body: 'Verify your identity to unlock all features.', totalTokens: 67, successCount: 64, failureCount: 3, status: 'partial' as any },
    { title: '💰 Cashback Credited!', body: '₹250 cashback has been added to your wallet.', totalTokens: 128, successCount: 128, failureCount: 0, status: 'sent' as any },
    { title: 'Market Update', body: 'Performance is up 2.3% today. Check your dashboard.', totalTokens: 215, successCount: 210, failureCount: 5, status: 'partial' as any },
    { title: 'SDK v5.0 Now Available', body: 'Major improvements to deep linking accuracy & speed.', totalTokens: 178, successCount: 0, failureCount: 178, status: 'failed' as any },
    { title: 'Referral Reward Unlocked 🎉', body: 'You earned ₹500 for referring a friend!', totalTokens: 95, successCount: 95, failureCount: 0, status: 'sent' as any },
    { title: 'New Blog Post', body: 'Deep Linking Best Practices for 2026 – Read now.', totalTokens: 310, successCount: 298, failureCount: 12, status: 'partial' as any },
  ];
  for (const l of pushLogs) {
    await pnlRepo.save(pnlRepo.create({
      ...l, projectId: project.id,
      data: { deepLink: 'https://chumbaq.com/notification', campaignId: `camp_${shortCode()}` },
      failureDetails: l.failureCount > 0 ? [{ token: `fcm_expired_${shortCode()}`, error: 'messaging/registration-token-not-registered' }] : undefined,
    } as any));
  }
  console.log(`   ✓ ${pushLogs.length} push notification logs`);

  // ──────────────────────────────────────────────────
  //  14. MIXPANEL CONFIG
  // ──────────────────────────────────────────────────
  console.log('\n14. Seeding Mixpanel config…');
  const mxConfRepo = ds.getRepository(MixpanelConfigEntity);
  await mxConfRepo.save(mxConfRepo.create({
    projectId: project.id,
    serviceAccountUsername: 'chumbaq-service.1a2b3c4d.mp-service-account',
    serviceAccountPasswordEncrypted: 'enc_dummy_password_base64_value_here',
    encryptionIv: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4',
    encryptionTag: 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5',
    mixpanelProjectId: '3456789',
    isActive: true, lastTestAt: randomDate(3),
  }));
  console.log('   ✓ 1 Mixpanel config');

  // ──────────────────────────────────────────────────
  //  15. MIXPANEL COHORTS (8) & MEMBERS
  // ──────────────────────────────────────────────────
  console.log('\n15. Seeding Mixpanel cohorts…');
  const cohortRepo = ds.getRepository(MixpanelCohortEntity);
  const cmRepo = ds.getRepository(MixpanelCohortMemberEntity);
  const cohortsData = [
    { mixpanelCohortId: 101, name: 'Power Users', description: 'Users with 10+ sessions in the last 30 days', mixpanelUserCount: 1247, resolvedCount: 1102, unresolvedCount: 145, status: 'synced' as any, lastSyncedAt: randomDate(1) },
    { mixpanelCohortId: 102, name: 'Churning Users', description: 'Users who haven\'t opened the app in 14+ days', mixpanelUserCount: 834, resolvedCount: 756, unresolvedCount: 78, status: 'synced' as any, lastSyncedAt: randomDate(1) },
    { mixpanelCohortId: 103, name: 'New Users (Last 7 Days)', description: 'Users who signed up in the last 7 days', mixpanelUserCount: 312, resolvedCount: 289, unresolvedCount: 23, status: 'synced' as any, lastSyncedAt: randomDate(1) },
    { mixpanelCohortId: 104, name: 'High-Value Customers', description: 'Users with total revenue > $100', mixpanelUserCount: 567, resolvedCount: 498, unresolvedCount: 69, status: 'synced' as any, lastSyncedAt: randomDate(2) },
    { mixpanelCohortId: 105, name: 'Trial Users', description: 'Users on free trial who haven\'t converted', mixpanelUserCount: 423, resolvedCount: 0, unresolvedCount: 423, status: 'pending' as any, lastSyncedAt: null },
    { mixpanelCohortId: 106, name: 'Cart Abandoners', description: 'Users who added items but didn\'t checkout in 48 hrs', mixpanelUserCount: 1589, resolvedCount: 1420, unresolvedCount: 169, status: 'synced' as any, lastSyncedAt: randomDate(1) },
    { mixpanelCohortId: 107, name: 'Repeat Buyers', description: 'Users who made 3+ purchases', mixpanelUserCount: 678, resolvedCount: 645, unresolvedCount: 33, status: 'synced' as any, lastSyncedAt: randomDate(1) },
    { mixpanelCohortId: 108, name: 'VIP Members', description: 'Users in VIP tier', mixpanelUserCount: 234, resolvedCount: 230, unresolvedCount: 4, status: 'synced' as any, lastSyncedAt: randomDate(0) },
  ];
  const savedCohorts: MixpanelCohortEntity[] = [];
  for (const c of cohortsData) savedCohorts.push(await cohortRepo.save(cohortRepo.create({ ...c, projectId: project.id })));

  let cmCount = 0;
  for (const cohort of savedCohorts.filter(c => c.status === 'synced')) {
    const members = savedDevices.slice(0, randomInt(5, 12));
    for (const dev of members) {
      await cmRepo.save(cmRepo.create({
        cohortId: cohort.id, projectId: project.id,
        mixpanelDistinctId: dev.distinctId || `mp_${fp()}`,
        deviceIdentityId: dev.id,
        resolvedBy: dev.externalUserId ? 'external_user_id' : 'distinct_id',
        isResolved: true,
        mixpanelProfile: { $first_name: dev.firstName, $last_name: dev.lastName, $email: `${dev.firstName?.toLowerCase()}.${dev.lastName?.toLowerCase()}@example.com`, $city: dev.city, $country_code: dev.countryCode },
      }));
      cmCount++;
    }
  }
  console.log(`   ✓ ${cohortsData.length} cohorts, ${cmCount} cohort members`);

  // ──────────────────────────────────────────────────
  //  16. IN-APP MESSAGE CAMPAIGNS (12)
  // ──────────────────────────────────────────────────
  console.log('\n16. Seeding in-app message campaigns…');
  const iamRepo = ds.getRepository(InAppMessageEntity);
  const iamData: any[] = [
    {
      name: 'Welcome New Users', messageType: 'modal', status: 'active',
      title: 'Welcome to Chumbaq! 👋', body: 'Thanks for joining! Let us help you create your first deep link in under 60 seconds.',
      imageUrl: pic(600, 300, 180), imagePosition: 'top',
      buttons: [{ id: 'btn_start', text: 'Get Started', action: 'deep_link', actionUrl: 'chumbaq://onboarding', style: 'primary' }, { id: 'btn_skip', text: 'Maybe Later', action: 'dismiss', style: 'text' }],
      theme: { backgroundColor: '#FFFFFF', textColor: '#1F2937', titleColor: '#111827', buttonPrimaryColor: '#4F46E5', borderRadius: 16, animation: 'scale' },
      dismissOnTapOutside: true, triggerType: 'on_app_open', triggerDelaySeconds: 2,
      userType: 'cohort', mixpanelCohortId: savedCohorts[2]?.id, startsAt: randomDate(14), endsAt: futureDate(30),
      priority: 10, maxImpressionsPerUser: 1, totalImpressions: 289, totalClicks: 187, totalDismissals: 43, tags: ['onboarding', 'welcome'], createdBy: admin.id,
    },
    {
      name: 'Feature Discovery – A/B Testing', messageType: 'bottom_sheet', status: 'active',
      title: 'Try A/B Testing ✨', body: 'Split test your links and discover which ones convert better. Set up your first experiment now!',
      imageUrl: pic(600, 200, 160), imagePosition: 'top',
      buttons: [{ id: 'btn_try', text: 'Try It Now', action: 'deep_link', actionUrl: 'chumbaq://links/ab-test', style: 'primary' }, { id: 'btn_learn', text: 'Learn More', action: 'url', actionUrl: 'https://docs.chumbaq.com/ab-testing', style: 'secondary' }],
      theme: { backgroundColor: '#FAFAFA', textColor: '#374151', titleColor: '#111827', buttonPrimaryColor: '#8B5CF6', borderRadius: 20, animation: 'slide_up' },
      dismissOnTapOutside: true, triggerType: 'on_event', triggerEvent: 'link_created', triggerDelaySeconds: 5,
      userType: 'all', startsAt: randomDate(7), endsAt: futureDate(60),
      priority: 5, maxImpressionsPerUser: 2, minIntervalSeconds: 86400 * 3, totalImpressions: 456, totalClicks: 123, totalDismissals: 189, tags: ['feature-discovery', 'ab-testing'], createdBy: admin.id,
    },
    {
      name: 'Upgrade to Pro', messageType: 'fullscreen', status: 'active',
      title: 'Unlock Pro Features 🔓', body: 'Get unlimited links, advanced analytics, custom domains, team collaboration, and priority support. Upgrade today and save 50%!',
      imageUrl: pic(800, 400, 175), imagePosition: 'top',
      buttons: [{ id: 'btn_upgrade', text: 'Upgrade Now – 50% Off', action: 'url', actionUrl: 'https://chumbaq.com/pricing?promo=IAM50', style: 'primary' }, { id: 'btn_later', text: 'Not Now', action: 'dismiss', style: 'text' }],
      theme: { backgroundColor: '#ECFDF5', textColor: '#065F46', titleColor: '#064E3B', buttonPrimaryColor: '#059669', overlayColor: 'rgba(0,0,0,0.6)', borderRadius: 24, animation: 'fade' },
      dismissOnTapOutside: false, autoDismissSeconds: 30, triggerType: 'on_event', triggerEvent: 'link_limit_reached', triggerDelaySeconds: 0,
      userType: 'cohort', mixpanelCohortId: savedCohorts[4]?.id, startsAt: randomDate(21), endsAt: futureDate(90),
      priority: 15, maxImpressionsPerUser: 3, minIntervalSeconds: 86400 * 7, totalImpressions: 1023, totalClicks: 312, totalDismissals: 567, tags: ['monetization', 'upgrade', 'promo'], createdBy: admin.id,
    },
    {
      name: 'Flash Sale Announcement', messageType: 'banner_top', status: 'active',
      title: '🔥 Flash Sale Live Now!', body: 'Up to 70% off on 500+ items. Ends in 24 hours!',
      imageUrl: null, imagePosition: 'top',
      buttons: [{ id: 'btn_shop', text: 'Shop Now', action: 'deep_link', actionUrl: 'chumbaq://deals/flash', style: 'primary' }],
      theme: { backgroundColor: '#FEF2F2', textColor: '#991B1B', titleColor: '#7F1D1D', buttonPrimaryColor: '#DC2626', borderRadius: 8, animation: 'slide_down' },
      dismissOnTapOutside: true, autoDismissSeconds: 10, triggerType: 'on_app_open', triggerDelaySeconds: 0,
      userType: 'all', startsAt: randomDate(3), endsAt: futureDate(2),
      priority: 20, maxImpressionsPerUser: 5, minIntervalSeconds: 3600, totalImpressions: 2341, totalClicks: 876, totalDismissals: 1234, tags: ['flash-sale', 'urgent'], createdBy: users[2].id,
    },
    {
      name: 'Cart Recovery', messageType: 'modal', status: 'active',
      title: 'You Left Items Behind! 🛒', body: 'Complete your purchase and get 10% off with code COMEBACK10.',
      imageUrl: pic(600, 300, 250), imagePosition: 'top',
      buttons: [{ id: 'btn_checkout', text: 'Complete Checkout', action: 'deep_link', actionUrl: 'chumbaq://cart/checkout', style: 'primary' }, { id: 'btn_dismiss', text: 'No Thanks', action: 'dismiss', style: 'text' }],
      theme: { backgroundColor: '#FFFBEB', textColor: '#78350F', titleColor: '#451A03', buttonPrimaryColor: '#D97706', borderRadius: 16, animation: 'scale' },
      dismissOnTapOutside: true, triggerType: 'on_event', triggerEvent: 'app_open_after_abandon', triggerDelaySeconds: 3,
      userType: 'cohort', mixpanelCohortId: savedCohorts[5]?.id, startsAt: randomDate(30), endsAt: futureDate(60),
      priority: 12, maxImpressionsPerUser: 2, minIntervalSeconds: 86400 * 2, totalImpressions: 1589, totalClicks: 634, totalDismissals: 456, tags: ['cart-recovery', 'retention'], createdBy: users[2].id,
    },
    {
      name: 'KYC Reminder', messageType: 'bottom_sheet', status: 'scheduled',
      title: 'Complete Your KYC ✅', body: 'Verify your identity to unlock all features. Takes only 2 minutes.',
      imageUrl: pic(600, 200, 340), imagePosition: 'top',
      buttons: [{ id: 'btn_verify', text: 'Verify Now', action: 'deep_link', actionUrl: 'chumbaq://kyc/start', style: 'primary' }, { id: 'btn_remind', text: 'Remind Me Later', action: 'dismiss', style: 'secondary' }],
      theme: { backgroundColor: '#F0FDF4', textColor: '#166534', titleColor: '#14532D', buttonPrimaryColor: '#059669', borderRadius: 16, animation: 'slide_up' },
      dismissOnTapOutside: true, triggerType: 'scheduled', triggerDelaySeconds: 0,
      userType: 'segment', userFilters: { platforms: ['ios', 'android'], appVersions: ['3.0+'] }, startsAt: futureDate(2), endsAt: futureDate(30),
      priority: 8, maxImpressionsPerUser: 3, minIntervalSeconds: 86400 * 3, totalImpressions: 0, totalClicks: 0, totalDismissals: 0, tags: ['kyc', 'compliance'], createdBy: admin.id,
    },
    {
      name: 'NPS Survey – Q2 2026', messageType: 'modal', status: 'draft',
      title: 'How are we doing? 📊', body: 'Rate your experience with Chumbaq on a scale of 1-10. Your feedback shapes our roadmap.',
      imageUrl: null, imagePosition: 'top',
      buttons: [{ id: 'btn_rate', text: 'Rate Now', action: 'url', actionUrl: 'https://chumbaq.com/nps', style: 'primary' }, { id: 'btn_skip', text: 'Skip', action: 'dismiss', style: 'text' }],
      theme: { backgroundColor: '#FFFFFF', textColor: '#4B5563', titleColor: '#111827', buttonPrimaryColor: '#3B82F6', borderRadius: 16, animation: 'fade' },
      dismissOnTapOutside: true, triggerType: 'on_event', triggerEvent: 'session_count_10', triggerDelaySeconds: 5,
      userType: 'cohort', mixpanelCohortId: savedCohorts[0]?.id,
      priority: 3, maxImpressionsPerUser: 1, totalImpressions: 0, totalClicks: 0, totalDismissals: 0, tags: ['survey', 'nps', 'feedback'], createdBy: users[3].id,
    },
    {
      name: 'Win-Back Inactive Users', messageType: 'fullscreen', status: 'paused',
      title: 'We Miss You! 💚', body: 'A lot has changed since your last visit. Check out our new features and get a special welcome-back offer.',
      imageUrl: pic(800, 400, 370), imagePosition: 'center',
      buttons: [{ id: 'btn_comeback', text: 'See What\'s New', action: 'deep_link', actionUrl: 'chumbaq://changelog', style: 'primary' }, { id: 'btn_bye', text: 'Maybe Later', action: 'dismiss', style: 'text' }],
      theme: { backgroundColor: '#EEF2FF', textColor: '#3730A3', titleColor: '#312E81', buttonPrimaryColor: '#6366F1', overlayColor: 'rgba(0,0,0,0.5)', borderRadius: 24, animation: 'fade' },
      dismissOnTapOutside: true, triggerType: 'on_app_open', triggerDelaySeconds: 0,
      userType: 'cohort', mixpanelCohortId: savedCohorts[1]?.id, startsAt: randomDate(45), endsAt: futureDate(15),
      priority: 8, maxImpressionsPerUser: 1, totalImpressions: 756, totalClicks: 234, totalDismissals: 398, tags: ['win-back', 'retention'], createdBy: admin.id,
    },
    {
      name: 'New Year Sale 2026', messageType: 'banner_bottom', status: 'completed',
      title: '🎉 New Year Sale – Ends Today!', body: 'Extra 25% off sitewide. Use code NEWYEAR26.',
      imageUrl: null, imagePosition: 'top',
      buttons: [{ id: 'btn_sale', text: 'Shop Sale', action: 'deep_link', actionUrl: 'chumbaq://sale/new-year', style: 'primary' }],
      theme: { backgroundColor: '#FDF2F8', textColor: '#9D174D', titleColor: '#831843', buttonPrimaryColor: '#DB2777', borderRadius: 8, animation: 'slide_up' },
      dismissOnTapOutside: true, autoDismissSeconds: 8, triggerType: 'on_app_open', triggerDelaySeconds: 0,
      userType: 'all', startsAt: new Date('2026-01-01'), endsAt: new Date('2026-01-07'),
      priority: 25, maxImpressionsPerUser: 10, totalImpressions: 8934, totalClicks: 3456, totalDismissals: 4123, tags: ['seasonal', 'sale', 'new-year'], createdBy: users[2].id,
    },
    {
      name: 'Referral Rewards', messageType: 'modal', status: 'active',
      title: 'Refer & Earn ₹500 🎉', body: 'Invite your friends to Chumbaq and earn ₹500 for every successful referral. No limits!',
      imageUrl: pic(600, 300, 399), imagePosition: 'top',
      buttons: [{ id: 'btn_refer', text: 'Refer Now', action: 'deep_link', actionUrl: 'chumbaq://referral', style: 'primary' }, { id: 'btn_terms', text: 'View Terms', action: 'url', actionUrl: 'https://chumbaq.com/referral-terms', style: 'text' }],
      theme: { backgroundColor: '#FAF5FF', textColor: '#581C87', titleColor: '#3B0764', buttonPrimaryColor: '#7C3AED', borderRadius: 16, animation: 'scale' },
      dismissOnTapOutside: true, triggerType: 'on_screen', triggerScreen: 'home', triggerDelaySeconds: 10,
      userType: 'all', startsAt: randomDate(10), endsAt: futureDate(45),
      priority: 6, maxImpressionsPerUser: 2, minIntervalSeconds: 86400 * 5, totalImpressions: 892, totalClicks: 345, totalDismissals: 289, tags: ['referral', 'growth'], createdBy: admin.id,
    },
    {
      name: 'Feature Highlight – Smart Redirects', messageType: 'bottom_sheet', status: 'active',
      title: 'Smart Redirects Are Here 🧠', body: 'Automatically route users to the right app store, web fallback, or deep link based on their device.',
      imageUrl: pic(600, 200, 430), imagePosition: 'top',
      buttons: [{ id: 'btn_explore', text: 'Explore', action: 'deep_link', actionUrl: 'chumbaq://settings/redirects', style: 'primary' }],
      theme: { backgroundColor: '#F0F9FF', textColor: '#0C4A6E', titleColor: '#082F49', buttonPrimaryColor: '#0284C7', borderRadius: 20, animation: 'slide_up' },
      dismissOnTapOutside: true, triggerType: 'on_event', triggerEvent: 'link_created', triggerDelaySeconds: 3,
      userType: 'all', startsAt: randomDate(5), endsAt: futureDate(40),
      priority: 4, maxImpressionsPerUser: 1, totalImpressions: 534, totalClicks: 212, totalDismissals: 156, tags: ['feature', 'smart-redirects'], createdBy: users[3].id,
    },
    {
      name: 'Weekend Engagement Boost', messageType: 'banner_top', status: 'active',
      title: '📈 Weekend Special: Double Analytics!', body: 'All link analytics refreshed every 5 min this weekend.',
      imageUrl: null, imagePosition: 'top',
      buttons: [{ id: 'btn_dash', text: 'View Dashboard', action: 'deep_link', actionUrl: 'chumbaq://dashboard', style: 'primary' }],
      theme: { backgroundColor: '#FFFBEB', textColor: '#78350F', titleColor: '#451A03', buttonPrimaryColor: '#F59E0B', borderRadius: 8, animation: 'slide_down' },
      dismissOnTapOutside: true, autoDismissSeconds: 8, triggerType: 'on_app_open', triggerDelaySeconds: 1,
      userType: 'cohort', mixpanelCohortId: savedCohorts[0]?.id, startsAt: randomDate(2), endsAt: futureDate(3),
      priority: 7, maxImpressionsPerUser: 3, totalImpressions: 1287, totalClicks: 543, totalDismissals: 678, tags: ['engagement', 'weekend'], createdBy: admin.id,
    },
  ];
  const savedMsgs: InAppMessageEntity[] = [];
  for (const m of iamData) {
    const saved = await iamRepo.save(iamRepo.create({ ...m, projectId: project.id } as any));
    savedMsgs.push(Array.isArray(saved) ? saved[0] : saved);
  }
  console.log(`   ✓ ${iamData.length} IAM campaigns`);

  // ──────────────────────────────────────────────────
  //  17. IAM IMPRESSIONS (400)
  // ──────────────────────────────────────────────────
  console.log('\n17. Seeding IAM impressions…');
  const impRepo = ds.getRepository(InAppMessageImpressionEntity);
  const activeMsgs = savedMsgs.filter(m => !['draft', 'scheduled'].includes(m.status));
  const impTypes: Array<'delivered' | 'impression' | 'click' | 'dismiss' | 'cta_click' | 'auto_dismiss'> = ['delivered', 'impression', 'click', 'dismiss', 'cta_click', 'auto_dismiss'];
  const impBatch: any[] = [];
  for (let i = 0; i < 400; i++) {
    const msg = randomFrom(activeMsgs);
    const dev = randomFrom(savedDevices);
    const co = randomFrom(COUNTRIES);
    impBatch.push({
      messageId: msg.id, projectId: project.id,
      deviceIdentityId: dev.id, distinctId: dev.distinctId, deviceFingerprint: dev.deviceFingerprint,
      eventType: randomFrom(impTypes), buttonId: Math.random() > 0.6 ? 'btn_start' : null,
      ipAddress: ip(), userAgent: randomFrom(USER_AGENTS), platform: randomFrom(PLATFORMS), country: co.name, city: randomFrom(co.cities),
    });
  }
  await impRepo.save(impBatch);
  console.log('   ✓ 400 IAM impressions');

  // ──────────────────────────────────────────────────
  //  18. PENDING MESSAGES (30)
  // ──────────────────────────────────────────────────
  console.log('\n18. Seeding pending messages…');
  const pendRepo = ds.getRepository(PendingMessageEntity);
  const pendBatch: any[] = [];
  for (let i = 0; i < 30; i++) {
    const msg = randomFrom(activeMsgs);
    const dev = randomFrom(savedDevices);
    pendBatch.push({
      messageId: msg.id, projectId: project.id,
      deviceFingerprint: dev.deviceFingerprint, distinctId: dev.distinctId,
      status: randomFrom(['pending', 'delivered', 'expired']), expiresAt: futureDate(7),
    });
  }
  await pendRepo.save(pendBatch);
  console.log('   ✓ 30 pending messages');

  // ──────────────────────────────────────────────────
  //  19. USER EVENTS – SDK (600)
  // ──────────────────────────────────────────────────
  console.log('\n19. Seeding user events…');
  const ueRepo = ds.getRepository(UserEventEntity);
  const ueBatch: any[] = [];
  for (let i = 0; i < 600; i++) {
    const dev = randomFrom(savedDevices);
    const evName = randomFrom(SDK_EVENTS);
    const co = randomFrom(COUNTRIES);
    const props: Record<string, unknown> = { session_id: `sess_${shortCode()}` };
    if (evName === 'screen_view') props.screen_name = randomFrom(['Home', 'Dashboard', 'Links', 'Analytics', 'Settings', 'Profile', 'Pricing']);
    else if (evName === 'purchase_completed') { props.revenue = parseFloat((Math.random() * 299 + 1).toFixed(2)); props.currency = randomFrom(['USD', 'INR', 'EUR']); props.item_count = randomInt(1, 5); }
    else if (evName === 'button_click') props.button_name = randomFrom(['create_link', 'view_analytics', 'share', 'upgrade', 'settings', 'logout']);
    else if (evName === 'search_performed') { props.query = randomFrom(['deep links', 'analytics', 'pricing', 'api docs', 'webhooks']); props.results_count = randomInt(0, 50); }

    ueBatch.push({
      projectId: project.id, deviceIdentityId: dev.id, distinctId: dev.distinctId,
      eventName: evName, properties: props,
      sourceType: randomFrom(['sdk', 'api', 'webhook']), sourceId: Math.random() > 0.5 ? `src_${shortCode()}` : undefined,
      ipAddress: ip(), userAgent: randomFrom(USER_AGENTS), platform: dev.platform,
      country: co.name, city: randomFrom(co.cities), timestamp: randomDate(30),
    });
  }
  await ueRepo.save(ueBatch);
  console.log('   ✓ 600 user events');

  // ──────────────────────────────────────────────────
  //  20. TOUCHPOINTS (500)
  // ──────────────────────────────────────────────────
  console.log('\n20. Seeding touchpoints…');
  const tpRepo = ds.getRepository(TouchpointEntity);
  const tpTypes: Array<'link_click' | 'email_open' | 'banner_view' | 'banner_click' | 'push_click' | 'page_view' | 'custom_event'> =
    ['link_click', 'email_open', 'banner_view', 'banner_click', 'push_click', 'page_view', 'custom_event'];
  const tpBatch: any[] = [];
  for (let i = 0; i < 500; i++) {
    const dev = randomFrom(savedDevices);
    const co = randomFrom(COUNTRIES);
    const tt = randomFrom(tpTypes);
    tpBatch.push({
      projectId: project.id, distinctId: dev.distinctId, deviceFingerprint: dev.deviceFingerprint,
      touchpointType: tt, channel: randomFrom(CHANNELS),
      campaign: randomFrom([...UTM_CAMPAIGNS, null, null]) || undefined,
      utmSource: randomFrom([...UTM_SOURCES, null, null]) || undefined,
      utmMedium: randomFrom([...UTM_MEDIUMS, null, null]) || undefined,
      utmCampaign: randomFrom([...UTM_CAMPAIGNS, null, null]) || undefined,
      utmTerm: Math.random() > 0.7 ? randomFrom(['deep linking', 'mobile attribution', 'app links', 'deferred deep links']) : undefined,
      utmContent: Math.random() > 0.7 ? randomFrom(['hero_banner', 'cta_button', 'footer_link', 'sidebar_ad']) : undefined,
      linkId: tt === 'link_click' ? randomFrom(allLinks).id : undefined,
      referrer: randomFrom(REFERRERS) || undefined,
      platform: dev.platform, deviceType: randomFrom(DEVICE_TYPES),
      country: co.name, city: randomFrom(co.cities), ipAddress: ip(),
      metadata: tt === 'page_view' ? { page: randomFrom(['/home', '/pricing', '/docs', '/blog', '/signup', '/dashboard']) } : undefined,
      touchedAt: randomDate(45),
    });
  }
  await tpRepo.save(tpBatch);
  console.log('   ✓ 500 touchpoints');

  // ──────────────────────────────────────────────────
  //  21. ATTRIBUTION RESULTS (80)
  // ──────────────────────────────────────────────────
  console.log('\n21. Seeding attribution results…');
  const attrRepo = ds.getRepository(AttributionResultEntity);
  const attrModels: Array<'last_touch' | 'first_touch' | 'linear' | 'time_decay'> = ['last_touch', 'first_touch', 'linear', 'time_decay'];
  const attrBatch: any[] = [];
  for (let i = 0; i < Math.min(savedConvs.length, 80); i++) {
    const conv = savedConvs[i];
    const model = randomFrom(attrModels);
    const tpCount = randomInt(1, 5);
    const splits: any[] = [];
    for (let j = 0; j < tpCount; j++) {
      splits.push({
        touchpointId: uuid(), touchpointType: randomFrom(tpTypes), channel: randomFrom(CHANNELS),
        campaign: randomFrom(UTM_CAMPAIGNS), utmSource: randomFrom(UTM_SOURCES), utmMedium: randomFrom(UTM_MEDIUMS),
        linkId: randomFrom(allLinks).id, credit: parseFloat((1 / tpCount).toFixed(4)), touchedAt: randomDate(30).toISOString(),
      });
    }
    attrBatch.push({
      projectId: project.id, conversionId: conv.id,
      distinctId: conv.distinctId || `anon_${shortCode()}`,
      model, creditSplits: splits, touchpointCount: tpCount, lookbackDays: randomFrom([7, 14, 30, 60]),
    });
  }
  await attrRepo.save(attrBatch);
  console.log(`   ✓ ${attrBatch.length} attribution results`);

  // ──────────────────────────────────────────────────
  //  22. WIDGET EVENTS (5000)
  // ──────────────────────────────────────────────────
  console.log('\n22. Seeding widget events…');
  const weRepo = ds.getRepository(WidgetEventEntity);
  const weBatch: any[] = [];
  for (let i = 0; i < 5000; i++) {
    const banner = randomFrom(savedBanners);
    const co = randomFrom(COUNTRIES);
    const eventType = Math.random() > 0.4 ? 'impression' : (Math.random() > 0.6 ? 'click' : 'dismiss');
    
    weBatch.push({
      bannerId: banner.id, categoryId: banner.categoryId,
      eventType: eventType,
      platform: randomFrom(PLATFORMS), country: co.name, city: randomFrom(co.cities), ipAddress: ip(),
      createdAt: randomDate(30), // Random date in last 30 days
    });
  }
  
  // Save in chunks to avoid postgres max query parameters limits
  for (let i = 0; i < weBatch.length; i += 500) {
    await weRepo.save(weBatch.slice(i, i + 500));
  }
  console.log('   ✓ 5000 widget events');

  // ──────────────────────────────────────────────────
  //  SUMMARY
  // ──────────────────────────────────────────────────
  console.log('\n\n✅ Seed complete!');
  console.log('═══════════════════════════════════════════════════');
  console.log(`  Project:             ${project.name}`);
  console.log(`  Project ID:          ${project.id}`);
  console.log('───────────────────────────────────────────────────');
  console.log(`  Users:               ${USERS.length}`);
  console.log(`  Links:               ${allLinks.length}`);
  console.log(`  Link Variants:       ${varCount}`);
  console.log(`  Device Identities:   ${DEVICE_COUNT}`);
  console.log(`  Click Events:        600`);
  console.log(`  Conversions:         100`);
  console.log(`  Teams:               3`);
  console.log(`  API Keys:            2`);
  console.log(`  Webhooks:            ${webhooksSeeded}`);
  console.log(`  Banner Categories:   ${catData.length}`);
  console.log(`  In-App Banners:      ${bannerData.length}`);
  console.log(`  Widget Events:       5000`);
  console.log(`  Push Tokens:         ${tokenCount}`);
  console.log(`  Push Logs:           ${pushLogs.length}`);
  console.log(`  Mixpanel Config:     1`);
  console.log(`  Mixpanel Cohorts:    ${cohortsData.length}`);
  console.log(`  Cohort Members:      ${cmCount}`);
  console.log(`  IAM Campaigns:       ${iamData.length}`);
  console.log(`  IAM Impressions:     400`);
  console.log(`  Pending Messages:    30`);
  console.log(`  User Events:         600`);
  console.log(`  Touchpoints:         500`);
  console.log(`  Attribution Results: ${attrBatch.length}`);
  console.log('═══════════════════════════════════════════════════');
  console.log('  Login: admin@chumbaq.com / admin123');
  console.log('  Login: dev@chumbaq.com / dev123');
  console.log('  Login: marketing@chumbaq.com / marketing123');
  console.log('  Login: product@chumbaq.com / product123');
  console.log('═══════════════════════════════════════════════════\n');

  await ds.destroy();
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
