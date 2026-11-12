import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';

/**
 * Person fields a campaign may substitute into its copy.
 *
 * An allow-list rather than "anything on the entity": the identity row also
 * carries ipAddress, userAgent and device fingerprints, and a marketer must
 * not be able to render those into a notification by guessing a field name.
 *
 * Every entry must be a real column on DeviceIdentityEntity. Anything
 * app-specific goes through `{{trait.*}}` instead.
 */
export const PERSONALISATION_FIELDS = [
  'firstName',
  'lastName',
  'phone',
  'email',
  'city',
  'country',
  'countryCode',
  'region',
  'locale',
  'language',
  'externalUserId',
  'distinctId',
] as const;

export type PersonalisationField = (typeof PERSONALISATION_FIELDS)[number];

/**
 * Matches `{{field}}` and `{{field|fallback}}`, tolerating inner whitespace.
 *
 * `trait.` prefixes reach into the identity's jsonb traits, which is where
 * anything app-specific lives.
 */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*(?:\|([^}]*))?\}\}/g;

/** True when the text contains at least one substitutable token. */
export function hasPersonalisation(...texts: Array<string | null | undefined>): boolean {
  return texts.some((text) => {
    if (!text) return false;
    TOKEN_PATTERN.lastIndex = 0;
    return TOKEN_PATTERN.test(text);
  });
}

function readField(
  identity: Partial<DeviceIdentityEntity> | null,
  field: string,
): unknown {
  if (!identity) return undefined;

  if (field.startsWith('trait.')) {
    const key = field.slice('trait.'.length);
    const traits = identity.traits as Record<string, unknown> | undefined;
    return traits?.[key];
  }

  return PERSONALISATION_FIELDS.includes(field as PersonalisationField)
    ? (identity as Record<string, unknown>)[field]
    : undefined;
}

/**
 * Substitutes `{{field}}` tokens in `text` from a person's attributes.
 *
 * An unresolved token falls back to its `|default` if one was written, and
 * otherwise renders as empty. It is never left as a literal `{{firstName}}`:
 * shipping raw template syntax to a user's lock screen is the one outcome
 * worse than a slightly generic greeting.
 */
export function renderTemplate(
  text: string,
  identity: Partial<DeviceIdentityEntity> | null,
  /**
   * Applied to substituted person data, never to the authored fallback.
   * Email HTML passes an HTML escaper: a trait is user-supplied, and a name
   * of `<img src=x onerror=...>` must arrive as text, not markup.
   */
  escapeValue: (value: string) => string = (value) => value,
): string {
  return text.replace(TOKEN_PATTERN, (_match, field: string, fallback?: string) => {
    const value = readField(identity, field);
    if (value === undefined || value === null || value === '') {
      return fallback ?? '';
    }
    return escapeValue(String(value));
  });
}

/**
 * Collapses whitespace left behind by an empty substitution.
 *
 * "Hi {{firstName}}, welcome" with no name would otherwise render as
 * "Hi , welcome". Punctuation immediately after a vanished token is dropped
 * along with it.
 */
export function tidyRendered(text: string): string {
  return text
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/([,;:])\s*([,.!?;:])/g, '$2')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Renders and tidies in one step; returns undefined for empty input. */
export function personalise(
  text: string | null | undefined,
  identity: Partial<DeviceIdentityEntity> | null,
): string | undefined {
  if (!text) return undefined;
  return tidyRendered(renderTemplate(text, identity));
}

/** Copy for one language. */
export interface PushTranslation {
  title?: string;
  body?: string;
}

/** Language code to copy, e.g. `{ hi: { title: '...' } }`. */
export type PushTranslations = Record<string, PushTranslation>;

/**
 * Picks the copy for a recipient's language.
 *
 * Matches the full tag first (`pt-BR`), then the base language (`pt`), so a
 * Brazilian recipient gets Brazilian copy when it exists and generic
 * Portuguese when it does not. Falls back to the campaign's own copy when
 * neither is present — an untranslated language must still receive the
 * campaign rather than nothing.
 *
 * `language` is preferred over `locale` because a device can report
 * `en-IN` as its locale while the user reads Hindi.
 */
export function pickTranslation(
  translations: PushTranslations | null | undefined,
  identity: { language?: string | null; locale?: string | null } | null,
): PushTranslation | null {
  if (!translations || !identity) return null;

  // Index the campaign's keys case-insensitively too: `pt-BR` in the campaign
  // must match `PT_br` from a device. Normalising only the device's tag would
  // miss it.
  const index = new Map(
    Object.entries(translations).map(([key, value]) => [
      key.replace('_', '-').toLowerCase(),
      value,
    ]),
  );

  const candidates = [identity.language, identity.locale]
    .filter((value): value is string => !!value)
    .flatMap((tag) => {
      const normalised = tag.replace('_', '-').toLowerCase();
      return [normalised, normalised.split('-')[0]];
    });

  for (const candidate of candidates) {
    const match = index.get(candidate);
    if (match && (match.title || match.body)) return match;
  }
  return null;
}
