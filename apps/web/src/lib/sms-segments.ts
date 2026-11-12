/**
 * How many billable segments a text is — the dashboard's copy of the API's
 * `countSegments` (apps/api/src/modules/sms/sms-rendering.ts). Keep the two
 * in step; `sms-segments.check.mjs` pins the same cases the API spec does.
 *
 * A message made only of GSM 03.38 characters is 160 to a segment; one
 * character outside it — an emoji, a curly quote, any Indic script —
 * switches the whole message to UCS-2, 70 to a segment. Past one segment,
 * each part loses room to the header that joins them: 153 and 67.
 */
const GSM_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM_EXTENDED = '^{}\\[~]|€\f';

const GSM_BASIC_SET = new Set(GSM_BASIC);
const GSM_EXTENDED_SET = new Set(GSM_EXTENDED);

export interface SmsSegments {
  encoding: 'GSM-7' | 'UCS-2';
  units: number;
  segments: number;
  /** Characters left before the next segment starts. */
  remaining: number;
  /** The first character that forced UCS-2, so the composer can name it. */
  unicodeCharacter: string | null;
}

export function countSegments(text: string): SmsSegments {
  let septets = 0;
  for (const char of text) {
    if (GSM_BASIC_SET.has(char)) septets += 1;
    else if (GSM_EXTENDED_SET.has(char)) septets += 2;
    else {
      const units = text.length;
      const segments = units <= 70 ? 1 : Math.ceil(units / 67);
      return {
        encoding: 'UCS-2',
        units,
        segments,
        remaining: (segments === 1 ? 70 : segments * 67) - units,
        unicodeCharacter: char,
      };
    }
  }
  const segments = septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153);
  return {
    encoding: 'GSM-7',
    units: septets,
    segments,
    remaining: (segments <= 1 ? 160 : segments * 153) - septets,
    unicodeCharacter: null,
  };
}

/** The text as it will be sent: with the opt-out line, unless it already says it. */
export function withOptOut(body: string, optOutText: string | null | undefined): string {
  const trimmed = body.trim();
  const optOut = optOutText?.trim();
  if (!optOut || trimmed.toLowerCase().includes(optOut.toLowerCase())) return trimmed;
  return `${trimmed}\n${optOut}`;
}
