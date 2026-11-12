import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  renderTemplate,
  tidyRendered,
} from '../push-notifications/push-personalisation';

/** What an SMS provider is handed for one recipient. */
export interface SmsMessage {
  /**
   * The sender: an E.164 number, an alphanumeric sender ID, or a Twilio
   * Messaging Service SID (`MG...`), which picks a number from its pool.
   */
  from: string;
  body: string;
  /**
   * Where the provider reports this message's delivery. Carries the campaign
   * and person in its query string, because SMS has no tags: Twilio signs the
   * whole URL, so what comes back can be trusted to be what was sent.
   */
  statusCallback?: string;
}

/** Twilio refuses bodies longer than this, whatever the encoding. */
export const MAX_SMS_LENGTH = 1600;

/** Default line appended so every marketing text says how to stop them. */
export const DEFAULT_OPT_OUT_TEXT = 'Reply STOP to opt out.';

/**
 * The GSM 03.38 alphabet. A message made only of these is sent 7 bits a
 * character, 160 to a segment; one character outside it — an emoji, a curly
 * quote, any Indic script — switches the whole message to UCS-2, 70 to a
 * segment. Carriers bill per segment, so this is what a send costs.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
/** In the alphabet, but sent as an escape plus the character: two septets. */
const GSM_EXTENDED = '^{}\\[~]|€\f';

const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

export interface SmsSegments {
  encoding: 'GSM-7' | 'UCS-2';
  /** Septets for GSM-7, UTF-16 code units for UCS-2: what the limits count. */
  units: number;
  segments: number;
}

/**
 * How many billable segments a text is.
 *
 * A message that fits in one segment gets the full 160 / 70; one that does
 * not loses room in every part to the header that stitches them back
 * together, leaving 153 / 67 each.
 */
export function countSegments(text: string): SmsSegments {
  let septets = 0;
  let gsm = true;
  for (const char of text) {
    if (GSM_BASIC_SET.has(char)) septets += 1;
    else if (GSM_EXTENDED_SET.has(char)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) {
    return {
      encoding: 'GSM-7',
      units: septets,
      segments: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153),
    };
  }
  // String length is UTF-16 code units, which is exactly what UCS-2 (as
  // carriers implement it, UTF-16) spends: an emoji costs two.
  const units = text.length;
  return {
    encoding: 'UCS-2',
    units,
    segments: units <= 70 ? 1 : Math.ceil(units / 67),
  };
}

/**
 * Removes control characters other than line breaks. A trait is
 * user-supplied, and a stray NUL or escape in it would garble the text or be
 * rejected by the carrier.
 */
function textSafe(value: string): string {
  return value.replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, ' ');
}

export interface RenderSmsInput {
  body: string;
  identity: Partial<DeviceIdentityEntity> | null;
  from: string;
  /** Appended on its own line unless the body already says it. Null for none. */
  optOutText: string | null;
  statusCallback?: string;
}

/**
 * Personalises a text for one person and adds the opt-out line.
 *
 * Tidied a line at a time: the push tidier collapses all whitespace, which
 * would join a text's deliberate line breaks into one line.
 */
export function renderSms(input: RenderSmsInput): SmsMessage {
  const personalised = renderTemplate(input.body, input.identity, textSafe)
    .split('\n')
    .map((line) => tidyRendered(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  const optOut = input.optOutText?.trim();
  const body =
    optOut && !personalised.toLowerCase().includes(optOut.toLowerCase())
      ? `${personalised}\n${optOut}`
      : personalised;

  return {
    from: input.from,
    body: body.slice(0, MAX_SMS_LENGTH),
    ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}),
  };
}
