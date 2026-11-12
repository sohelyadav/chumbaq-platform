import { IsString, IsOptional, IsObject, IsUUID, IsNumber, IsBoolean, MaxLength} from 'class-validator';

/**
 * Deliberately no `ipAddress`. It was stored on the identity and fed to
 * `resolveGeo`, under API-key auth only — and the key ships inside every app
 * binary — so any caller could write an arbitrary address and an arbitrary
 * derived country and city onto an identity. Nothing joins on the raw column,
 * but the geo columns it writes are aggregated in the dashboards, so a field
 * nobody could verify was shaping reported numbers.
 *
 * The address now comes from the request via `getClientIp` and nowhere else,
 * the same rule as `FingerprintDto`. None of the four SDKs ever sent it, so
 * removing it breaks no shipped client.
 */
export class IdentifyDto {
  @IsUUID()
  projectId: string;

  @IsString()
  @MaxLength(255)
  deviceFingerprint: string;

  @IsString()
  @MaxLength(50)
  platform: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  distinctId?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  externalUserId?: string;

  @IsObject()
  @IsOptional()
  traits?: Record<string, unknown>;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  userAgent?: string;

  // --- Profile ---
  @IsString()
  @IsOptional()
  @MaxLength(100)
  firstName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  lastName?: string;

  @IsString()
  @IsOptional()
  @MaxLength(20)
  phone?: string;

  /**
   * Where this person receives email. Optional, and also read from the
   * `$email` / `email` trait, which is what shipped SDKs already send — so
   * no client has to change for email campaigns to reach its users.
   */
  @IsString()
  @IsOptional()
  @MaxLength(320)
  email?: string;

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  avatar?: string;

  /**
   * BCP-47, matched to `device_identities.locale` at varchar(35).
   *
   * Both were varchar(10) with no length check, so `en-US-POSIX` — a genuine
   * Apple locale identifier at 11 characters, which the Flutter agent hit on
   * a simulator — reached the insert and returned a raw 500, taking the whole
   * `identify` call with it. `WidenLocaleAndLanguage` widened the columns;
   * this limit exists so an absurd value is still an honest 400 rather than a
   * 500. Truncating server-side was rejected: nothing downstream could tell a
   * mangled locale from a real one.
   */
  @IsString()
  @IsOptional()
  @MaxLength(35)
  locale?: string;

  @IsString()
  @IsOptional()
  @MaxLength(35)
  language?: string;

  // --- Device ---
  @IsString()
  @IsOptional()
  @MaxLength(50)
  os?: string;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  osVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  browser?: string;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  browserVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(50)
  appVersion?: string;

  @IsString()
  @IsOptional()
  @MaxLength(30)
  appBuild?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  manufacturer?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  brand?: string;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  model?: string;

  @IsNumber()
  @IsOptional()
  screenHeight?: number;

  @IsNumber()
  @IsOptional()
  screenWidth?: number;

  @IsString()
  @IsOptional()
  @MaxLength(100)
  carrier?: string;

  // --- Geo ---
  @IsString()
  @IsOptional()
  @MaxLength(50)
  timezone?: string;

  // --- Attribution ---
  @IsString()
  @IsOptional()
  @MaxLength(2048)
  referrer?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  utmSource?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  utmMedium?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  utmCampaign?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  utmContent?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  utmTerm?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  installSource?: string;

  @IsString()
  @IsOptional()
  @MaxLength(255)
  installCampaign?: string;

  // --- Consent ---
  @IsBoolean()
  @IsOptional()
  emailOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  smsOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  whatsappOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  pushOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  gdprConsent?: boolean;

  @IsBoolean()
  @IsOptional()
  doNotTrack?: boolean;
}

export class UpdateConsentDto {
  @IsBoolean()
  @IsOptional()
  emailOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  smsOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  whatsappOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  pushOptIn?: boolean;

  @IsBoolean()
  @IsOptional()
  gdprConsent?: boolean;

  @IsBoolean()
  @IsOptional()
  doNotTrack?: boolean;
}

export class TrackRevenueDto {
  @IsUUID()
  projectId: string;

  @IsString()
  deviceFingerprint: string;

  @IsNumber()
  amount: number;

  @IsString()
  @IsOptional()
  @MaxLength(3)
  currency?: string;

  @IsString()
  @IsOptional()
  eventType?: string;
}
