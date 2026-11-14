// ─── User ───────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserPublic {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

// ─── Project ────────────────────────────────────────────────────────────────

/** What a person is in a project. See the team-roles design, "Roles and permissions". */
export type ProjectRole = 'owner' | 'admin' | 'member';

/** What a role may do in a project. The API's `ROLE_PERMISSIONS` maps roles to these. */
export type ProjectPermission =
  | 'project.read'
  | 'messaging.write'
  | 'people.read'
  | 'channels.manage'
  | 'keys.manage'
  | 'members.manage'
  | 'activity.view'
  | 'privacy'
  | 'project.admin';

export interface Project {
  id: string;
  name: string;
  domain: string;
  iosBundleId?: string;
  iosAppStoreUrl?: string;
  iosTeamId?: string;
  iosAppStoreId?: string;
  androidPackageName?: string;
  androidPlayStoreUrl?: string;
  androidSha256Fingerprints?: string[];
  webFallbackUrl?: string;
  ownerId: string;
  /** The caller's role in this project. */
  role: ProjectRole;
  /** Whether the project is billed to the caller (`ownerId` is theirs). */
  isBillingOwner: boolean;
  /** What the caller's role may do here, so the dashboard can hide what it would refuse. */
  permissions: ProjectPermission[];
  createdAt: Date;
  updatedAt: Date;
}

/** Seats on a billing account: people with access to its projects, and its limit (null: none). */
export interface ProjectSeats {
  used: number;
  limit: number | null;
}

/** One person in a project, as `GET /api/projects/:projectId/members` lists them. */
export interface ProjectMember {
  userId: string;
  email: string;
  name: string;
  role: ProjectRole;
  /** The project is billed to this person (`projects.owner_id`). Always an owner. */
  isBillingOwner: boolean;
  /** When they joined the project (ISO 8601). */
  createdAt: string;
}

/** A pending offer of billing ownership to another owner, until `expiresAt` (ISO 8601). */
export type BillingOffer = {
  toUserId: string;
  offeredAt: string;
  expiresAt: string;
} | null;

/** `GET /api/projects/:projectId/members`, and what the member and billing writes return. */
export interface ProjectMembersResponse {
  members: ProjectMember[];
  /** Null when there is no offer, or it has expired. */
  billingOffer: BillingOffer;
}

/** A pending invitation, as `GET /api/projects/:projectId/invitations` lists them. */
export interface ProjectInvitation {
  id: string;
  /** Lower-case, as stored. */
  email: string;
  role: ProjectRole;
  /** Null once the inviter's account is gone. */
  invitedBy: { id: string; name: string } | null;
  /** ISO 8601. */
  expiresAt: string;
  createdAt: string;
  /** Past `expiresAt`: it can no longer be accepted, only resent or revoked. */
  expired: boolean;
}

/**
 * What creating or resending an invitation returns. `inviteUrl` is shown this once: only
 * a hash of its token is stored, so it can never be shown again (resend makes a new one).
 */
export interface CreatedInvitation {
  invitation: ProjectInvitation;
  inviteUrl: string;
  /** False when platform email is not set up or the provider refused it: share the link by hand. */
  emailSent: boolean;
  /** Set when no email was attempted because the account sent its daily invite allowance. */
  emailSkipped?: 'daily_limit';
}

/** `POST /api/invitations/preview`: what the invite page shows before accepting. */
export interface InvitationPreview {
  projectName: string;
  role: ProjectRole;
  inviterName: string | null;
  /** `s***@example.com`. */
  invitedEmailMasked: string;
  /** The signed-in account's email is the invited one. */
  matchesAccount: boolean;
  /** Platform email is set up and this account's address is not yet verified. */
  emailVerificationRequired: boolean;
}

/** `meta` of `GET /api/projects`. */
export interface ProjectListMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  /** How many projects the caller may own. */
  projectLimit: number;
  /** How many projects are billed to the caller: what `projectLimit` counts. */
  billedProjects: number;
  seats: ProjectSeats;
}

// ─── Link ───────────────────────────────────────────────────────────────────

export interface Link {
  id: string;
  shortCode: string;
  longUrl: string;
  iosUrl?: string;
  androidUrl?: string;
  iosFallbackUrl?: string;
  androidFallbackUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageUrl?: string;
  deepLinkParams?: Record<string, unknown>;
  isActive: boolean;
  expiresAt?: Date;
  title?: string;
  tags?: string[];
  projectId: string;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Click Event ────────────────────────────────────────────────────────────

export type RedirectType = 'app_deeplink' | 'app_store' | 'play_store' | 'web_fallback';

export interface ClickEvent {
  id: string;
  linkId: string;
  clickedAt: Date;
  ipAddress: string;
  userAgent: string;
  referrer?: string;
  platform: string;
  deviceType: string;
  os: string;
  osVersion?: string;
  browser: string;
  browserVersion?: string;
  country?: string;
  countryCode?: string;
  city?: string;
  region?: string;
  redirectType: RedirectType;
  isDeferred: boolean;
  matched: boolean;
}

// ─── Conversion Event ───────────────────────────────────────────────────────

export type ConversionEventType = 'install' | 'signup' | 'purchase' | string;

export interface ConversionEvent {
  id: string;
  linkId: string;
  clickEventId?: string;
  eventType: ConversionEventType;
  externalUserId?: string;
  metadata?: Record<string, unknown>;
  convertedAt: Date;
}

// ─── DTOs ───────────────────────────────────────────────────────────────────

export interface RegisterDto {
  email: string;
  password: string;
  name: string;
}

export interface LoginDto {
  email: string;
  password: string;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

/**
 * On a sign-in or re-authentication with a second factor. That cancels any staff reset
 * of the account's factors, and this is `true` only when the cancel failed: the client
 * should then show the waiting reset and its cancel button. Absent otherwise. The API
 * also refuses to run a reset requested before such a sign-in, so this is the owner's
 * second chance, not the only one.
 */
export interface FactorResetPending {
  factorResetPending?: true;
}

/**
 * A complete sign-in voids every password reset link support issued for the account.
 * When that void failed, sign-in and re-authentication responses say so, and the
 * dashboard shows the link's cancel banner. Absent when false.
 */
export interface StaffLinkPending {
  staffLinkPending?: true;
}

export interface AuthResponse extends FactorResetPending, StaffLinkPending {
  user: UserPublic;
  tokens: AuthTokens;
}

/** `POST /auth/reauth` and the passkey, TOTP and recovery-code re-authentications. */
export interface ReauthResponse extends FactorResetPending, StaffLinkPending {
  accessToken: string;
}

/** `GET /auth/me` adds this: whether a reset link support issued is still live. */
export interface ProfileStaffLink {
  staffLinkPending: boolean;
}

/**
 * `GET /auth/me` adds this: whether this install takes payments (so the dashboard shows
 * its billing page). Always false while viewing as another account.
 */
export interface ProfileBilling {
  billingEnabled: boolean;
}

/** `POST /auth/staff-reset-link/cancel`: how many unused links were spent. */
export interface CancelStaffLinkResponse {
  cancelled: number;
}

export interface CreateProjectDto {
  name: string;
  domain: string;
  iosBundleId?: string;
  iosAppStoreUrl?: string;
  iosTeamId?: string;
  iosAppStoreId?: string;
  androidPackageName?: string;
  androidPlayStoreUrl?: string;
  androidSha256Fingerprints?: string[];
  webFallbackUrl?: string;
}

export interface UpdateProjectDto extends Partial<CreateProjectDto> {}

export interface CreateLinkDto {
  longUrl: string;
  /** Optional user-supplied slug. 3–30 chars, [a-zA-Z0-9_-]. If omitted, a random 7-char code is generated. */
  shortCode?: string;
  iosUrl?: string;
  androidUrl?: string;
  iosFallbackUrl?: string;
  androidFallbackUrl?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImageUrl?: string;
  deepLinkParams?: Record<string, unknown>;
  isActive?: boolean;
  expiresAt?: string;
  title?: string;
  tags?: string[];
}

// shortCode is immutable after creation — omitted from the update DTO.
export interface UpdateLinkDto extends Partial<Omit<CreateLinkDto, 'shortCode'>> {}

/**
 * What a device may say about itself when claiming a deferred deep link.
 *
 * Named rather than inline so the API's `FingerprintDto` can declare
 * `implements DeferredFingerprint` — this interface and that class are one
 * contract, and until they were tied together they drifted silently: this
 * copy still required an `ip` long after the API had made it optional, and
 * then long after the API had deleted it outright.
 *
 * There is deliberately no `ip`. The matcher pairs an install with a click
 * from the same address and derives that address from the request, because an
 * IP in the body is an instruction to claim whoever's click came from it —
 * and the project API key ships inside every app binary. The API's
 * `forbidNonWhitelisted` makes a body that still carries one a 400.
 */
export interface DeferredFingerprint {
  os: string;
  osVersion?: string;
  model?: string;
  screenWidth?: number;
  screenHeight?: number;
}

export interface DeferredMatchDto {
  fingerprint?: DeferredFingerprint;
  cookieRef?: string;
}

export interface DeferredMatchResponse {
  matched: boolean;
  linkId?: string;
  shortCode?: string;
  params?: Record<string, unknown>;
}

export interface CreateConversionDto {
  shortCode: string;
  linkId: string;
  eventType: ConversionEventType;
  externalUserId?: string;
  metadata?: Record<string, unknown>;
}

// ─── API Response Wrappers ──────────────────────────────────────────────────

export interface ApiResponse<T> {
  data: T;
  meta?: Record<string, unknown>;
}

export interface PaginatedResponse<T> {
  data: T[];
  meta: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// ─── Analytics ──────────────────────────────────────────────────────────────

export interface AnalyticsSummary {
  totalClicks: number;
  uniqueClickers: number;
  appDeeplinks: number;
  storeRedirects: number;
  webFallbacks: number;
  matchedInstalls: number;
  conversions: number;
  conversionRate: number;
}

export interface TimeseriesPoint {
  date: string;
  clicks: number;
}

export interface DeviceBreakdown {
  deviceType: Record<string, number>;
  os: Record<string, number>;
  browser: Record<string, number>;
}

export interface GeoEntry {
  country: string;
  countryCode: string;
  city?: string;
  count: number;
}

export interface ReferrerEntry {
  referrer: string;
  count: number;
}

export interface DashboardStats {
  totalLinks: number;
  totalClicks: number;
  clicks24h: number;
  clicks7d: number;
  clicks30d: number;
  totalConversions: number;
  topLinks: Array<{
    id: string;
    shortCode: string;
    title?: string;
    clicks: number;
  }>;
}

// ─── Identity ──────────────────────────────────────────────────────────────

export interface IdentifyParams {
  projectId: string;
  deviceFingerprint: string;
  platform: string;
  distinctId?: string;
  externalUserId?: string;
  traits?: Record<string, unknown>;
}

export interface DeviceIdentity {
  id: string;
  projectId: string;
  externalUserId?: string;
  distinctId?: string;
  deviceFingerprint: string;
  platform: string;
  traits?: Record<string, unknown>;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

// ─── Push Tokens ───────────────────────────────────────────────────────────

export type PushPlatform = 'ios' | 'android' | 'web';
export type PushProvider = 'fcm' | 'apns';

export interface RegisterPushTokenParams {
  projectId: string;
  deviceFingerprint: string;
  token: string;
  platform: PushPlatform;
  provider?: PushProvider;
}

export interface PushToken {
  id: string;
  projectId: string;
  deviceIdentityId: string;
  token: string;
  platform: PushPlatform;
  provider: PushProvider;
  isActive: boolean;
  createdAt: Date;
}

// ─── Push Notifications ────────────────────────────────────────────────────

export interface SendPushNotificationParams {
  projectId: string;
  title: string;
  body?: string;
  data?: Record<string, string>;
  imageUrl?: string;
  deviceIdentityIds?: string[];
}

export interface SendToUserParams {
  projectId: string;
  distinctId: string;
  title: string;
  body?: string;
  data?: Record<string, string>;
  imageUrl?: string;
}

export type NotificationStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'partial';

export interface PushNotificationLog {
  id: string;
  projectId: string;
  title: string;
  body?: string;
  data?: Record<string, string>;
  imageUrl?: string;
  totalTokens: number;
  processedTokens: number;
  successCount: number;
  failureCount: number;
  status: NotificationStatus;
  errorMessage?: string;
  sentAt: Date;
  completedAt?: Date;
}

// ─── Segments ──────────────────────────────────────────────────────────────

export type SegmentAttributeOp =
  | 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte'
  | 'contains' | 'in' | 'exists' | 'not_exists';

export type SegmentOccurrence = 'at_least' | 'at_most' | 'exactly' | 'none';

export interface SegmentGroupNode {
  type: 'group';
  operator: 'and' | 'or';
  negate?: boolean;
  children: SegmentAstNode[];
}

export interface SegmentAttributeNode {
  type: 'attribute';
  field: string;
  op: SegmentAttributeOp;
  value: string | number | boolean | Array<string | number> | null;
}

/**
 * The same value union SegmentAttributeNode carries. Declared once so a
 * property predicate cannot drift from an attribute rule — this file is R17's
 * single definition, and `unknown` here would let the future query builder
 * emit ASTs the API's validateAst rejects.
 */
export interface SegmentPropertyPredicate {
  property: string;
  op: SegmentAttributeOp;
  value: string | number | boolean | Array<string | number> | null;
}

export interface SegmentBehaviourNode {
  type: 'behaviour';
  eventName: string;
  occurrence: SegmentOccurrence;
  count: number;
  withinDays: number;
  where?: SegmentPropertyPredicate[];
}

export type SegmentAstNode =
  | SegmentGroupNode
  | SegmentAttributeNode
  | SegmentBehaviourNode;

export type SegmentEvaluationMode = 'live' | 'materialized';
export type SegmentStatus = 'draft' | 'active' | 'error';

export interface Segment {
  id: string;
  projectId: string;
  name: string;
  description?: string;
  definition: SegmentAstNode;
  evaluationMode: SegmentEvaluationMode;
  refreshIntervalMinutes: number;
  status: SegmentStatus;
  errorMessage?: string;
  lastMemberCount?: number;
  lastMaterializedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Super admin ────────────────────────────────────────────────────────────

export type AdminAuditAction =
  /** Staff made a trap API key or trap account; `metadata.kind` says which. */
  | 'tripwire.created'
  /** Staff switched a trap off. */
  | 'tripwire.revoked'
  /** The CERT-In incident register; `target_id` is the incident. */
  | 'incident.recorded'
  | 'incident.reported'
  | 'incident.note_added'
  | 'incident.closed'
  /** The organisation and point of contact the CERT-In report draft uses. */
  | 'security_contact.updated'
  | 'tenant.suspended'
  | 'tenant.reactivated'
  | 'tenant.impersonated'
  | 'super_admin.granted'
  | 'super_admin.revoked'
  | 'super_admin.passkeys_reset'
  | 'account.factors_reset'
  /** A staff read of a tenant's detail, at most one per staff member and tenant per window. */
  | 'tenant.viewed'
  | 'audit_log.exported'
  /** Staff downloaded the tenants list as CSV; `metadata` has the filters, `rowCount` and `truncated`. */
  | 'tenants.exported'
  | 'account.factors_reset_requested'
  | 'account.factors_reset_cancelled'
  /** A password reset refused because staff removed the account's factors recently. */
  | 'account.password_reset_refused'
  /** Staff issued a one-time password reset link through the CLI, after verifying who asked. */
  | 'account.password_reset_link_issued'
  /**
   * A staff-issued reset link spent before use: the owner signed in or cancelled it, or
   * the CLI could not tell the owner about it (`metadata.reason`).
   */
  | 'account.password_reset_link_cancelled'
  /** A sign-in that should have voided the owner's staff links could not. */
  | 'account.password_reset_link_void_failed'
  /** Staff set or cleared an account's own project limit; `metadata` has `before` and `after`. */
  | 'account.project_limit_changed'
  /** Staff set or cleared an account's own seat limit; `metadata` has `before`, `after` and `defaultLimit`. */
  | 'account.seat_limit_changed'
  /** A full staff sign-in on the admin app; `metadata.amr` says how. */
  | 'staff.signed_in'
  /** A known staff member's wrong password or factor on the admin app; `metadata.reason`. */
  | 'staff.sign_in_failed'
  | 'staff.signed_out'
  /** A staff session ended other than by signing out, e.g. a replayed refresh token. */
  | 'staff.session_revoked'
  /** A password-only session that can only enrol a first staff factor. */
  | 'staff.enrolment_started'
  /**
   * `admin:staff-enrolment` made a one-time enrolment code, good for 24 hours;
   * `metadata.allowanceId` matches the `staff.enrolment_started` that spent it.
   */
  | 'staff.enrolment_allowed'
  | 'staff.factor_added'
  | 'staff.factor_removed'
  /** The customer app exchanged a view-as code for the read-only session. */
  | 'tenant.impersonation_exchanged'
  /** A view-as code was spent but refused on its recheck; `metadata.reason` says why. */
  | 'tenant.impersonation_refused'
  /** Staff created a plan; `targetLabel` is its code, `metadata` its limits. */
  | 'billing.plan_created'
  /** Staff changed a plan's name, limits, order or availability; `metadata` has `before` and `after`. */
  | 'billing.plan_updated'
  /** Staff added a price to a plan, checked against the provider's plan; it replaces the current one. */
  | 'billing.price_added'
  /** Staff stopped offering a price; subscriptions on it keep it. */
  | 'billing.price_retired'
  /** Staff gave an account a plan without payment, with an optional end. */
  | 'billing.comp_granted'
  | 'billing.comp_ended'
  /** Staff cancelled an account's subscription at the provider; `metadata.atCycleEnd`. */
  | 'billing.subscription_cancelled'
  /** Staff had the provider email an invoice's link to the customer again. */
  | 'billing.invoice_resent';

export type AdminTenantStatus = 'active' | 'suspended';

// ─── Usage (daily roll-up, admin API) ───────────────────────────────────────

/**
 * What the usage roll-up counts per project per UTC day. The first nine are
 * counted from the day's rows; `mau_month_to_date` (devices active so far that
 * month) and `api_keys_active` are snapshots.
 */
export type UsageMetric =
  | 'push_sent'
  | 'email_sent'
  | 'sms_sent'
  | 'whatsapp_sent'
  | 'messages_failed'
  | 'in_app_impressions'
  | 'clicks'
  | 'events'
  | 'new_people'
  | 'mau_month_to_date'
  | 'api_keys_active';

/** One value per metric; null means not counted (outside what the roll-up covers), never 0. */
export type UsageValues = Record<UsageMetric, number | null>;

/** What the usage tables cover, as UTC days (`YYYY-MM-DD`). */
export interface UsageCoverage {
  /** The roll-up's first run. */
  startedOn: string;
  /** The first day counted. */
  countedFrom: string;
  /** The last closed day, null until one is closed. Nothing after it is shown. */
  countedThrough: string | null;
  /** The first day of the month active devices are counted from. */
  mauFrom: string;
}

export interface UsageDay {
  date: string;
  values: UsageValues;
}

/** A calendar month: counted metrics summed, snapshots as on `through`. */
export interface UsageMonth {
  /** `YYYY-MM`. */
  month: string;
  from: string;
  through: string;
  /** The month is not wholly inside the counted range. */
  partial: boolean;
  values: UsageValues;
}

export interface AdminTenantUsageRef {
  id: string;
  email: string;
  name: string;
  mauThisMonth: number;
  messagesSent30d: number;
  lastUsageDay: string | null;
}

/** Overlapping filters, not states: a tenant can be new and never have used anything. */
export type AdminTenantActivity = 'new' | 'quiet' | 'never_used';
export type AdminTenantSort = 'created_at' | 'mau_this_month' | 'messages_sent_30d' | 'last_usage_day';
export type AdminSortOrder = 'asc' | 'desc';
/** The tenant's effective plan code: `free`, or a plan staff created. */
export type AdminTenantPlan = string;

/** One tenant's usage, all of it from closed days of rows billed to that account. */
export interface AdminTenantUsage {
  coverage: UsageCoverage | null;
  days: number;
  series: UsageDay[];
  thisMonth: UsageMonth | null;
  lastMonth: UsageMonth | null;
  /** Per project over the series' days; `name` is null for a deleted project. */
  projects: { projectId: string; name: string | null; values: UsageValues }[];
}

export interface AdminTenantSummary {
  id: string;
  email: string;
  name: string;
  status: AdminTenantStatus;
  isSuperAdmin: boolean;
  suspendedAt: string | null;
  suspendedReason: string | null;
  createdAt: string;
  projectCount: number;
  linkCount: number;
  identityCount: number;
  clicksLast30d: number;
  lastActivityAt: string | null;
  /** Monthly active devices on the last counted day, across the account's projects. */
  mauThisMonth: number;
  /** Messages sent in the 30 counted days ending on the last counted day. */
  messagesSent30d: number;
  /** The last counted day with any counted usage, or null if none. */
  lastUsageDay: string | null;
  /** The effective plan's code; `free` for every account while billing is off. */
  plan: AdminTenantPlan;
}

export interface AdminTenantProject {
  id: string;
  name: string;
  domain: string | null;
  createdAt: string;
  linkCount: number;
  identityCount: number;
  clicksLast30d: number;
  activeApiKeyCount: number;
}

export interface AdminAuditLog {
  id: string;
  actorId: string | null;
  actorEmail: string;
  action: AdminAuditAction;
  targetType: string;
  targetId: string | null;
  targetLabel: string | null;
  reason: string | null;
  metadata: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

export interface AdminTenantDetail extends AdminTenantSummary {
  /** Staff's override for this account, or null for the default. */
  projectLimit: number | null;
  /** What creating a project is checked against: the override, else the default. */
  effectiveProjectLimit: number;
  /** Staff's seat-limit override for this account, or null for the default. */
  seatLimit: number | null;
  /** What invites are checked against: the override, else the default; null is no limit. */
  effectiveSeatLimit: number | null;
  /** People on the account: its owner, members of its projects, and live invitations. */
  seatsUsed: number;
  projects: AdminTenantProject[];
  recentAudit: AdminAuditLog[];
  /** The latest successful sign-in still in the sign-in history, or null. */
  lastSignInAt: string | null;
}

/**
 * How staff confirmed who was asking for a factor reset, by some means other than the
 * account's email: whoever holds the mailbox may not be the owner.
 */
export type FactorResetVerificationMethod =
  | 'video_call'
  | 'government_id'
  | 'phone_call_known_number'
  | 'billing_record'
  | 'other';

/** A staff-assisted reset of a tenant's second factors, waiting out its delay. */
export interface AdminPendingFactorReset {
  id: string;
  requestedAt: string;
  /** When the worker removes the factors, unless it is cancelled first. */
  executeAfter: string;
  requestedByEmail: string;
  reason: string;
  /**
   * When the owner's warning was confirmed sent, or null if it has not been yet. The
   * wait runs from here, so a reset whose warning has not gone out does not run.
   */
  noticeSentAt: string | null;
  /** Why staff went ahead although the password had been reset recently, if they had to. */
  passwordResetOverride: string | null;
  /** Null only on resets requested before this was recorded. */
  verificationMethod: FactorResetVerificationMethod | null;
  verificationNotes: string | null;
}

export interface AdminFactorResetState {
  /** False when there is nothing to reset, so a request would be refused. */
  hasFactors: boolean;
  pending: AdminPendingFactorReset | null;
  /**
   * The latest password reset, by email or by a team admin. Within the last 14 days, a
   * request needs `recentResetJustification` as well as a reason.
   */
  lastPasswordResetAt: string | null;
  /** False when account email is not set up: the owner cannot be warned, so no reset. */
  emailConfigured: boolean;
}

export interface AdminImpersonationSession {
  accessToken: string;
  expiresAt: string;
  tenant: {
    id: string;
    email: string;
    name: string;
  };
}

/**
 * What the admin API answers to "view as": a link to the customer app carrying a
 * one-time code, which the customer app exchanges for an `AdminImpersonationSession`.
 */
export interface ImpersonationHandoff {
  /** `${APP_URL}/impersonate#code=<code>`; the code is only ever in the fragment. */
  url: string;
  /** ISO, 60 s after creation. */
  expiresAt: string;
  tenant: { id: string; email: string; name: string };
}

// ── Staff sign-in on the admin app ──

export type StaffSecondFactor = 'webauthn' | 'totp';

export interface StaffSessionInfo {
  id: string;
  enrolmentOnly: boolean;
  /** When this access token expires (ISO). */
  accessExpiresAt: string;
  /** Absolute end of the session (ISO): sign-in + STAFF_SESSION_MAX_AGE, or + STAFF_ENROLMENT_SESSION_TTL. */
  expiresAt: string;
  idleTimeoutSeconds: number;
}

export interface StaffSignedIn {
  step: 'signed_in';
  accessToken: string;
  session: StaffSessionInfo;
}

export interface StaffEnrolmentStarted {
  step: 'enrol';
  accessToken: string;
  session: StaffSessionInfo;
}

export interface StaffSecondFactorRequired {
  step: 'second_factor';
  handle: string;
  methods: StaffSecondFactor[];
}

export type StaffLoginResult = StaffSignedIn | StaffEnrolmentStarted | StaffSecondFactorRequired;

export interface StaffRefreshed {
  accessToken: string;
  session: StaffSessionInfo;
}

export interface StaffReauthenticated {
  accessToken: string;
}

export interface StaffPasskey {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: string;
  backedUp: boolean;
}

export interface StaffFactors {
  passkeys: StaffPasskey[];
  totp: { enabled: boolean; available: boolean };
  /** False when removing any one would leave no staff factor. */
  canRemove: boolean;
}

export interface StaffProfile {
  id: string;
  email: string;
  name: string;
  enrolmentOnly: boolean;
  factors: { passkeys: number; totp: boolean };
  session: StaffSessionInfo;
  /** Whether this install takes payments, so the admin app shows its billing pages. */
  billingEnabled: boolean;
}

export interface StaffEnrolled {
  enrolled: true;
  /** True for an enrolment-only session, which has now ended. */
  signInAgain: boolean;
}

export interface AdminOverview {
  tenants: {
    total: number;
    active: number;
    suspended: number;
    newLast30d: number;
  };
  projects: number;
  links: number;
  identities: number;
  clicksLast30d: number;
  signupsByDay: { date: string; count: number }[];
  /** Null before the usage roll-up first runs. */
  usageCoverage: UsageCoverage | null;
  /** Counted metrics summed over the 30 counted days to `countedThrough`; snapshots on that day. */
  usage30d: UsageValues | null;
  /** The last 90 counted days, all tenants together. */
  usageTrend: UsageDay[];
  /** Up to 10, by messages sent in 30 days plus monthly active devices. */
  topTenants: AdminTenantUsageRef[];
  /** Tenants with usage before but none in the last 14 counted days; the first 10 of `count`. */
  quietTenants: { count: number; tenants: AdminTenantUsageRef[] };
}

export interface AdminHealth {
  status: 'ok' | 'degraded';
  checkedAt: string;
  database: { ok: boolean; latencyMs: number | null };
  redis: { ok: boolean; latencyMs: number | null };
  /** Account email. Not part of `status`: a deployment can run without it. */
  platformEmail: { configured: boolean; from: string | null };
  /**
   * The server clock's sync, from `chronyc -c tracking` (CERT-In: sync to NIC/NPL).
   * Not part of `status`; `unknown` where chrony is not installed (development).
   */
  clock: AdminClock;
  queues: {
    name: string;
    waiting: number;
    active: number;
    delayed: number;
    failed: number;
  }[];
}

// ─── Account recovery ───────────────────────────────────────────────────────

/** `unavailable`: the email could not be sent, or no sender is configured. */
export type ResendVerificationStatus = 'sent' | 'already_verified' | 'unavailable';

export interface ResendVerificationResponse {
  status: ResendVerificationStatus;
}

// ─── Sessions and sign-in history ───────────────────────────────────────────

/** A device signed in to the account. `device` is null when the browser does not say. */
export interface AccountSession {
  id: string;
  device: string | null;
  ipAddress: string | null;
  signedInAt: string;
  lastActiveAt: string;
  /** The session making this request. */
  current: boolean;
}

export type AccountActivityType =
  | 'register.succeeded'
  | 'login.succeeded'
  | 'login.failed'
  | 'passkey.added'
  | 'passkey.removed'
  | 'totp.enabled'
  | 'totp.disabled'
  | 'recovery_code.used'
  | 'recovery_codes.regenerated'
  | 'refresh.reuse_detected'
  | 'logout.all'
  | 'session.revoked'
  | 'sessions.revoked_others'
  | 'password.changed'
  | 'password.reset'
  | 'password.reset_by_team'
  | 'email.verified'
  | 'factors_reset.requested'
  | 'factors_reset.cancelled'
  | 'factors_reset.completed';

export interface AccountActivity {
  id: string;
  type: AccountActivityType;
  device: string | null;
  ipAddress: string | null;
  at: string;
  /** Happened in the session making this request. */
  current: boolean;
}

/** What the owner is told of a staff reset of their factors: not who asked, nor why. */
export interface AccountFactorResetState {
  pending: { requestedAt: string; executeAfter: string } | null;
}

export interface AccountActivityResponse {
  activity: AccountActivity[];
  /** How far back `activity` goes. */
  days: number;
}

// ─── Privacy: person erasure and export (DPDP) ───
// Design: docs/superpowers/specs/2026-11-07-person-erasure-export.md

/**
 * What an API key may do. `privacy` is server-only: a key holding it carries
 * nothing else, is never in the default set, and is refused by every SDK route.
 * (Types only: this package is not loaded at runtime. The API's list is
 * `API_KEY_PERMISSIONS` in `api-keys/api-key-permissions.ts`.)
 */
export type ApiKeyPermission = 'read' | 'write' | 'privacy';

/** How a privacy request names the person. */
export type PrivacySubjectType = 'personId' | 'externalUserId' | 'deviceFingerprint';

export interface PrivacySubject {
  type: PrivacySubjectType;
  value: string;
}

/** Body of `POST /api/projects/:projectId/privacy-requests/search`. */
export interface PrivacyRequestSearch {
  externalUserId?: string;
  limit?: number;
}

/** Body of the server API's `POST /api/privacy/erasures` and `/exports`: exactly one field. */
export interface PrivacyRequestBody {
  externalUserId?: string;
  deviceFingerprint?: string;
}

export type PersonErasureOutcome = 'erased' | 'nothing_to_erase';

export interface PersonErasureResult {
  result: PersonErasureOutcome;
  /** The `privacy_request_logs` row recording this request. */
  requestId: string;
  /** Rows affected per table. Suppressions are counted only in the request log, never here. */
  counts: Record<string, number>;
  /** What erasure leaves on purpose (rows under ids never linked to this user, backups, providers). */
  notErased: string[];
}

export interface PersonExportSection {
  total: number;
  truncated: boolean;
  rows: Record<string, unknown>[];
}

export interface PersonExport {
  exportedAt: string;
  projectId: string;
  subject: PrivacySubject;
  rowCapPerSection: number;
  truncated: boolean;
  /** What the export leaves out on purpose (rows under ids never linked to this person). */
  notIncluded: string[];
  sections: Record<string, PersonExportSection>;
}

export type PrivacyRequestKind = 'erasure' | 'export';
export type PrivacyActorType = 'user' | 'api_key';

/** One row of a project's privacy request log. Holds hashes and counts, never identifiers. */
export interface PrivacyRequestLog {
  id: string;
  kind: PrivacyRequestKind;
  subjectType: PrivacySubjectType;
  actorType: PrivacyActorType;
  actorId: string | null;
  result: string;
  counts: Record<string, number>;
  createdAt: string;
}

// ─── Project activity log ───────────────────────────────────────────────────

/**
 * Every consequential action a project's activity log records. See the activity-log
 * design, "What is logged". The page builds its sentence from this and the stored labels.
 */
export type ProjectActivityAction =
  // Team
  | 'member.invited'
  | 'invite.resent'
  | 'invite.cancelled'
  | 'invite.accepted'
  | 'member.role_changed'
  | 'member.removed'
  | 'member.left'
  | 'billing.transfer_offered'
  | 'billing.transfer_accepted'
  | 'billing.transfer_declined'
  | 'billing.transfer_cancelled'
  // Project
  | 'project.renamed'
  | 'project.app_links_changed'
  | 'project.deleted'
  // API keys
  | 'api_key.created'
  | 'api_key.revoked'
  // Channels
  | 'channel.settings_changed'
  | 'channel.provider_changed'
  | 'channel.credentials_uploaded'
  | 'email.ses_topic_reset'
  | 'email.webhook_token_rotated'
  | 'webhook.created'
  | 'webhook.changed'
  | 'webhook.secret_rotated'
  | 'webhook.deleted'
  | 'mixpanel.configured'
  // Messaging
  | 'campaign.sent'
  | 'campaign.scheduled'
  | 'campaign.cancelled'
  | 'push.sent_to_person'
  | 'cohort.push_sent'
  | 'cohort.in_app_triggered'
  | 'in_app.triggered'
  | 'journey.status_changed'
  | 'in_app_message.activated'
  | 'in_app_message.paused'
  | 'content.deleted'
  | 'link.changed'
  // Privacy (shown only to viewers with the `privacy` permission)
  | 'person.erased'
  | 'person.exported'
  | 'person.consent_changed'
  | 'tracking.objection_recorded'
  | 'tracking.objection_lifted'
  | 'suppression.added'
  | 'suppression.removed'
  // Activity
  | 'activity.exported'
  // Chumbaq staff
  | 'staff.viewed_as';

/** The kinds of action the Activity page filters by. */
export const PROJECT_ACTIVITY_GROUPS = [
  'team',
  'project',
  'api_keys',
  'channels',
  'messaging',
  'privacy',
  'activity',
  'staff',
] as const;

export type ProjectActivityGroup = (typeof PROJECT_ACTIVITY_GROUPS)[number];

/** Which filter group each action belongs to. */
export const ACTIVITY_ACTION_GROUP: Record<ProjectActivityAction, ProjectActivityGroup> = {
  'member.invited': 'team',
  'invite.resent': 'team',
  'invite.cancelled': 'team',
  'invite.accepted': 'team',
  'member.role_changed': 'team',
  'member.removed': 'team',
  'member.left': 'team',
  'billing.transfer_offered': 'team',
  'billing.transfer_accepted': 'team',
  'billing.transfer_declined': 'team',
  'billing.transfer_cancelled': 'team',
  'project.renamed': 'project',
  'project.app_links_changed': 'project',
  'project.deleted': 'project',
  'api_key.created': 'api_keys',
  'api_key.revoked': 'api_keys',
  'channel.settings_changed': 'channels',
  'channel.provider_changed': 'channels',
  'channel.credentials_uploaded': 'channels',
  'email.ses_topic_reset': 'channels',
  'email.webhook_token_rotated': 'channels',
  'webhook.created': 'channels',
  'webhook.changed': 'channels',
  'webhook.secret_rotated': 'channels',
  'webhook.deleted': 'channels',
  'mixpanel.configured': 'channels',
  'campaign.sent': 'messaging',
  'campaign.scheduled': 'messaging',
  'campaign.cancelled': 'messaging',
  'push.sent_to_person': 'messaging',
  'cohort.push_sent': 'messaging',
  'cohort.in_app_triggered': 'messaging',
  'in_app.triggered': 'messaging',
  'journey.status_changed': 'messaging',
  'in_app_message.activated': 'messaging',
  'in_app_message.paused': 'messaging',
  'content.deleted': 'messaging',
  'link.changed': 'messaging',
  'person.erased': 'privacy',
  'person.exported': 'privacy',
  'person.consent_changed': 'privacy',
  'tracking.objection_recorded': 'privacy',
  'tracking.objection_lifted': 'privacy',
  'suppression.added': 'privacy',
  'suppression.removed': 'privacy',
  'activity.exported': 'activity',
  'staff.viewed_as': 'staff',
};

/** Who did it. `app` is reserved for the MCP server; nothing writes it yet. */
export type ProjectActivityActorKind = 'user' | 'staff' | 'api_key' | 'system' | 'app';

/** One row of a project's activity log, as the API returns it. Times are UTC ISO 8601. */
export interface ProjectActivityEntry {
  id: string;
  occurredAt: string;
  actorKind: ProjectActivityActorKind;
  /** No foreign key: kept after the account is deleted or leaves the project. */
  actorUserId: string | null;
  /** The actor's name and email at the time, e.g. "Priya (priya@acme.com)". */
  actorLabel: string;
  action: ProjectActivityAction;
  group: ProjectActivityGroup;
  targetType: string | null;
  targetId: string | null;
  /** The target's name at the time. */
  targetLabel: string | null;
  /** Only the keys allowed for the action. Never secrets or end-user personal data. */
  details: Record<string, unknown> | null;
  ipAddress: string | null;
  country: string | null;
  userAgent: string | null;
}

/**
 * A page of the log, newest first. `actors` is everyone who appears in it, past or present:
 * people only (signed-in users), never staff, API keys or the system, so `userId` is set.
 */
export interface ProjectActivityPage {
  entries: ProjectActivityEntry[];
  nextCursor: string | null;
  actors: { userId: string; label: string }[];
}

// ---- Security alarms (CERT-In readiness)

/** What raised a security alarm. Staff are emailed for each; see the CERT-In design. */
export type SecurityAlertKind =
  | 'server.ssh_login'
  | 'server.ssh_banned'
  | 'server.files_changed'
  | 'staff.new_device'
  | 'staff.failed_sign_ins'
  | 'data.bulk_export'
  | 'data.unusual_reads'
  | 'tripwire.api_key'
  | 'tripwire.account';

export interface SecurityAlertView {
  id: string;
  kind: SecurityAlertKind;
  key: string;
  details: Record<string, string | number | null>;
  ip: string | null;
  firstAt: string;
  lastAt: string;
  /** How many times it was raised in this 15-minute window. */
  count: number;
  emailedAt: string | null;
  emailFailed: boolean;
}

/** A trap: a fake API key or a watched email address. Touching it raises an alarm. */
export interface TripwireView {
  id: string;
  kind: 'api_key' | 'account';
  label: string;
  createdAt: string;
  revokedAt: string | null;
}

// ---- Incidents (CERT-In readiness)

/** CERT-In Directions (28 April 2022), Annexure I: the incident types that must be reported. */
export type CertInIncidentType =
  | 'i' | 'ii' | 'iii' | 'iv' | 'v' | 'vi' | 'vii' | 'viii' | 'ix' | 'x'
  | 'xi' | 'xii' | 'xiii' | 'xiv' | 'xv' | 'xvi' | 'xvii' | 'xviii' | 'xix' | 'xx';

export type IncidentStatus = 'open' | 'reported' | 'closed';
export type IncidentReportMethod = 'email' | 'phone' | 'fax' | 'portal';

export interface IncidentSummary {
  id: string;
  title: string;
  types: CertInIncidentType[];
  status: IncidentStatus;
  noticedAt: string;
  /** noticedAt + 6 hours. */
  deadline: string;
  reportedAt: string | null;
  closedAt: string | null;
}

export interface IncidentNote {
  id: string;
  createdAt: string;
  createdBy: string | null;
  note: string;
}

export interface IncidentDetail extends IncidentSummary {
  recordedAt: string;
  recordedBy: string | null;
  howNoticed: string;
  summary: string;
  systems: string;
  tenantIds: string[];
  alertId: string | null;
  reportedBy: string | null;
  reportMethod: IncidentReportMethod | null;
  certinReference: string | null;
  closedBy: string | null;
  /** A reminder (or the first email) could not be sent to every staff member. */
  reminderEmailFailed: boolean;
  notes: IncidentNote[];
  /** The command that gathers the logs for this incident's window on the server. */
  logCommand: string;
}

export interface SecurityContact {
  orgName: string | null;
  orgAddress: string | null;
  sector: string | null;
  pocName: string | null;
  pocRole: string | null;
  pocEmail: string | null;
  pocPhone: string | null;
  updatedAt: string | null;
}

export interface AdminClock {
  /** ok up to 100 ms off, warn up to 1 s, bad beyond that or with no source. */
  state: 'ok' | 'warn' | 'bad' | 'unknown';
  source: string | null;
  stratum: number | null;
  offsetMs: number | null;
}

/**
 * CERT-In Directions (28 April 2022), Annexure I, verbatim, for the admin app. The API
 * keeps its own copy (it must not value-import this package); a test holds them equal.
 */
export const CERT_IN_ANNEXURE_I: readonly { id: CertInIncidentType; label: string }[] = [
  { id: 'i', label: 'Targeted scanning/probing of critical networks/systems' },
  { id: 'ii', label: 'Compromise of critical systems/information' },
  { id: 'iii', label: 'Unauthorised access of IT systems/data' },
  {
    id: 'iv',
    label:
      'Defacement of website or intrusion into a website and unauthorised changes such as inserting malicious code, links to external websites etc.',
  },
  {
    id: 'v',
    label: 'Malicious code attacks such as spreading of virus/worm/Trojan/Bots/Spyware/Ransomware/Cryptominers',
  },
  { id: 'vi', label: 'Attack on servers such as Database, Mail and DNS and network devices such as Routers' },
  { id: 'vii', label: 'Identity Theft, spoofing and phishing attacks' },
  { id: 'viii', label: 'Denial of Service (DoS) and Distributed Denial of Service (DDoS) attacks' },
  {
    id: 'ix',
    label: 'Attacks on Critical infrastructure, SCADA and operational technology systems and Wireless networks',
  },
  { id: 'x', label: 'Attacks on Application such as E-Governance, E-Commerce etc.' },
  { id: 'xi', label: 'Data Breach' },
  { id: 'xii', label: 'Data Leak' },
  {
    id: 'xiii',
    label: 'Attacks on Internet of Things (IoT) devices and associated systems, networks, software, servers',
  },
  { id: 'xiv', label: 'Attacks or incident affecting Digital Payment systems' },
  { id: 'xv', label: 'Attacks through Malicious mobile Apps' },
  { id: 'xvi', label: 'Fake mobile Apps' },
  { id: 'xvii', label: 'Unauthorised access to social media accounts' },
  {
    id: 'xviii',
    label: 'Attacks or malicious/ suspicious activities affecting Cloud computing systems/servers/software/applications',
  },
  {
    id: 'xix',
    label:
      'Attacks or malicious/suspicious activities affecting systems/ servers/ networks/ software/ applications related to Big Data, Block chain, virtual assets, virtual asset exchanges, custodian wallets, Robotics, 3D and 4D Printing, additive manufacturing, Drones',
  },
  {
    id: 'xx',
    label:
      'Attacks or malicious/ suspicious activities affecting systems/ servers/software/ applications related to Artificial Intelligence and Machine Learning',
  },
];

// ---------------------------------------------------------------------------
// Plans and billing. Money is integer paise everywhere; prices exclude GST and
// `amountPaise` is what is charged.
// ---------------------------------------------------------------------------

export type BillingInterval = 'monthly' | 'yearly';

/** The billing provider's own subscription statuses, mirrored as they arrive. */
export type BillingSubscriptionStatus =
  | 'created'
  | 'authenticated'
  | 'active'
  | 'pending'
  | 'halted'
  | 'cancelled'
  | 'completed'
  | 'expired';

/** Where an account's plan comes from. */
export type BillingPlanSource = 'free' | 'subscription' | 'comp';

/** An account's billing state, derived from its subscriptions and comp. */
export type BillingAccountState =
  | 'free'
  | 'checkout'
  | 'active'
  | 'past_due'
  | 'halted'
  | 'cancelling'
  | 'change_scheduled'
  | 'upgrade_pending'
  | 'comped';

/** A plan's limits; null is unlimited (a null project limit is the install's default). */
export interface PlanLimits {
  mauLimit: number | null;
  projectLimit: number | null;
  seatLimit: number | null;
}

export interface BillingPrice {
  id: string;
  interval: BillingInterval;
  /** Excluding GST. */
  pricePaise: number;
  taxPaise: number;
  /** Including GST: what is charged. */
  amountPaise: number;
  taxRateBps: number;
}

export interface BillingPlanOption extends PlanLimits {
  code: string;
  name: string;
  sortOrder: number;
  monthly: BillingPrice | null;
  yearly: BillingPrice | null;
}

export interface BillingAddress {
  line1: string;
  line2: string | null;
  city: string;
  postalCode: string;
  country: 'IN';
}

export interface BillingDetails {
  legalName: string;
  gstin: string | null;
  address: BillingAddress;
  /** Two-digit GST state code: the place of supply. */
  stateCode: string;
}

export interface BillingSubscriptionView {
  id: string;
  planCode: string;
  planName: string;
  interval: BillingInterval;
  status: BillingSubscriptionStatus;
  amountPaise: number;
  currentPeriodEnd: string | null;
  startAt: string | null;
  cancelAtPeriodEnd: boolean;
  graceUntil: string | null;
}

export interface BillingInvoiceView {
  id: string;
  number: string | null;
  status: string;
  amountPaise: number;
  taxPaise: number;
  /** As the provider reported it: INR for every invoice our prices produce. */
  currency: string;
  periodStart: string | null;
  periodEnd: string | null;
  issuedAt: string | null;
  paidAt: string | null;
  shortUrl: string | null;
}

export interface BillingUsage {
  mau: { used: number | null; limit: number | null; month: string | null; countedThrough: string | null };
  projects: { used: number; limit: number };
  seats: { used: number; limit: number | null };
}

export interface BillingOverview {
  state: BillingAccountState;
  effectivePlan: { code: string; name: string; source: BillingPlanSource; until: string | null };
  current: BillingSubscriptionView | null;
  next: BillingSubscriptionView | null;
  comp: { planCode: string; until: string | null } | null;
  usage: BillingUsage;
  plans: BillingPlanOption[];
  details: BillingDetails | null;
  /** The provider's public key id, for its checkout. Never a secret. */
  keyId: string;
}

/** A price as staff see it: with the provider's plan id, whether it is offered, and who is on it. */
export interface AdminPlanPrice extends BillingPrice {
  razorpayPlanId: string;
  isCurrent: boolean;
  createdAt: string;
  /** Subscriptions on this price that are authorised or live (authenticated, active, pending, halted). */
  subscribers: number;
}

export interface AdminPlan extends PlanLimits {
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Current prices first, then earlier ones, newest first. */
  prices: AdminPlanPrice[];
  /** Whether this server takes payments; prices can be added only when it does. */
  billingEnabled: boolean;
  /**
   * The install's defaults, which a null limit stands for: the project limit on every
   * plan, the seat limit on the free plan (null is no seat limit).
   */
  defaults: { projectLimit: number; seatLimit: number | null };
}

/** Money split by GST, all integer paise: `grossPaise = netPaise + taxPaise`. */
export interface MoneySplit {
  netPaise: number;
  taxPaise: number;
  grossPaise: number;
}

export interface AdminBillingPayment {
  id: string;
  tenantId: string;
  tenantEmail: string;
  amountPaise: number;
  refundedPaise: number;
  /** What was kept, excluding GST: `amountPaise - refundedPaise` less its GST. */
  netPaise: number;
  status: 'captured' | 'failed' | 'refunded';
  method: string | null;
  failureReason: string | null;
  paidAt: string;
  /** Charged on a subscription that was replaced before it ever became the account's own. */
  orphan: boolean;
}

export interface AdminBillingSummary {
  /** Monthly recurring revenue of paying accounts (comps excluded). */
  mrr: MoneySplit;
  arr: MoneySplit;
  byPlan: { planCode: string; planName: string; accounts: number; mrrNetPaise: number }[];
  /** Payments kept (captured less refunds) in the last 30 days. */
  revenue30d: MoneySplit;
  /** The last 12 UTC months, oldest first, months with nothing included as zeros. `month` is `YYYY-MM`. */
  revenueByMonth: ({ month: string } & MoneySplit)[];
  pastDue: {
    tenantId: string;
    email: string;
    status: 'pending' | 'halted';
    since: string;
    daysOverdue: number;
    graceUntil: string | null;
  }[];
  /** The 20 newest payments of any status. */
  recentPayments: AdminBillingPayment[];
  /** The 20 newest failed payments. */
  recentFailures: AdminBillingPayment[];
  overMau: { tenantId: string; email: string; planCode: string; mau: number; limit: number }[];
  comped: { tenantId: string; email: string; planCode: string; until: string | null; reason: string }[];
  /** Accounts whose subscription ends at the period end. */
  cancelling: number;
  /** Cancels the worker could not send yet; `error` is the provider's answer as stored. */
  outboxErrors: { subscriptionId: string; tenantId: string; error: string; attempts: number }[];
}

export interface AdminTenantBilling {
  overview: Omit<BillingOverview, 'plans' | 'keyId'>;
  comp: { planCode: string; until: string | null; reason: string; byEmail: string | null; at: string } | null;
  subscriptions: (BillingSubscriptionView & {
    providerSubscriptionId: string;
    method: string | null;
    supersededBy: string | null;
    createdAt: string;
  })[];
  invoices: BillingInvoiceView[];
  payments: AdminBillingPayment[];
}

export interface BillingCheckout {
  subscriptionId: string;
  keyId: string;
  customerId: string | null;
  prefill: { name: string; email: string };
  startsAt: string | null;
}
