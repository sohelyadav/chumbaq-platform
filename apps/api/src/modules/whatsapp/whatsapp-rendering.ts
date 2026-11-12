import { DeviceIdentityEntity } from '../identity/entities/device-identity.entity';
import {
  renderTemplate,
  tidyRendered,
} from '../push-notifications/push-personalisation';
import { WhatsAppContent } from '../push-notifications/message-channel';

/** What a WhatsApp provider is handed for one recipient. */
export interface WhatsAppMessage {
  template: WhatsAppContent['template'];
  bodyParams: string[];
  headerText: string | null;
  headerMediaUrl: string | null;
  headerMediaType: 'image' | 'video' | 'document' | null;
  buttonParams: string[];
  /**
   * Carried with the send and returned on delivery reports, by whatever
   * means the provider offers (Meta's `biz_opaque_callback_data`,
   * Interakt's `callbackData`, a Twilio callback URL), so a report finds its
   * way back to the campaign and the person.
   */
  campaignId: string | null;
  identityId: string | null;
  /** Where the provider should report this message's status, if per-message. */
  statusCallback?: string;
}

/**
 * The longest a single template parameter may be. Meta rejects longer
 * values outright; a long trait would otherwise fail the whole message.
 */
export const MAX_PARAM_LENGTH = 1024;

/**
 * One parameter for one person.
 *
 * Meta refuses parameters containing newlines, tabs or more than four
 * consecutive spaces (error 132018), and an empty one (132000). A trait can
 * bring any of these, so they are normalised away rather than failing the
 * send: whitespace collapsed, and an empty result replaced by a dash, which
 * reads better in a template than a missing word and is never rejected.
 */
export function renderParam(
  value: string,
  identity: Partial<DeviceIdentityEntity> | null,
): string {
  const rendered = tidyRendered(renderTemplate(value, identity))
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
    .slice(0, MAX_PARAM_LENGTH);
  return rendered || '-';
}

export function renderWhatsApp(input: {
  content: WhatsAppContent;
  identity: Partial<DeviceIdentityEntity> | null;
  campaignId: string | null;
  identityId: string | null;
  statusCallback?: string;
}): WhatsAppMessage {
  const { content, identity } = input;
  return {
    template: content.template,
    bodyParams: content.bodyParams.map((value) => renderParam(value, identity)),
    headerText: content.headerText ? renderParam(content.headerText, identity) : null,
    headerMediaUrl: content.headerMediaUrl ?? null,
    headerMediaType: content.headerMediaUrl
      ? (content.headerMediaType ?? guessMediaType(content.headerMediaUrl))
      : null,
    buttonParams: (content.buttonParams ?? []).map((value) =>
      // A URL suffix: no spaces at all, and personalisation URL-encoded so a
      // name with an ampersand cannot add a query parameter.
      renderTemplate(value, identity, encodeURIComponent).replace(/\s+/g, ''),
    ),
    campaignId: input.campaignId,
    identityId: input.identityId,
    ...(input.statusCallback ? { statusCallback: input.statusCallback } : {}),
  };
}

/** A media header's kind from its URL, when the template did not say. */
export function guessMediaType(url: string): 'image' | 'video' | 'document' {
  const path = url.split('?')[0].toLowerCase();
  if (/\.(mp4|3gp|mov)$/.test(path)) return 'video';
  if (/\.(pdf|docx?|xlsx?|pptx?|txt|csv)$/.test(path)) return 'document';
  return 'image';
}

/**
 * The template body with this person's values in place, for previews and
 * for providers (Twilio's fallback, logs) that want the text itself.
 */
export function previewWhatsApp(bodyText: string, params: string[]): string {
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (match, index: string) => {
    const value = params[Number(index) - 1];
    return value === undefined ? match : value;
  });
}
