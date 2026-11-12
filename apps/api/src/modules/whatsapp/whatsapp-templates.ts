import { WhatsAppContent } from '../push-notifications/message-channel';
import { WhatsAppTemplate } from './providers/whatsapp-provider';

/**
 * Why a campaign's content cannot be sent with this template, or null.
 *
 * Checked when the campaign is created, against the provider's own list: a
 * wrong parameter count or an unapproved template fails every recipient at
 * the provider (Meta 132000 / 132001 / 132015), and finding out at send
 * time means a campaign that reaches nobody.
 */
export function templateProblem(
  content: WhatsAppContent,
  template: WhatsAppTemplate | undefined,
): string | null {
  if (!template) {
    return `The template "${content.template.name}" (${content.template.language}) was not found in this WhatsApp account.`;
  }
  if (template.status !== 'APPROVED') {
    return `The template "${template.name}" is ${template.status.toLowerCase()}, not approved, so WhatsApp will refuse it.`;
  }
  if (content.bodyParams.length !== template.bodyParamCount) {
    return `The template "${template.name}" has ${template.bodyParamCount} body value(s); this campaign gives ${content.bodyParams.length}.`;
  }
  if (content.bodyParams.some((value) => !value.trim())) {
    return 'Every body value needs something in it; WhatsApp refuses empty ones.';
  }
  const header = template.header;
  if (header?.format === 'TEXT' && header.paramCount > 0 && !content.headerText?.trim()) {
    return `The template "${template.name}" has a value in its header; fill it in.`;
  }
  if (header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(header.format)) {
    if (!content.headerMediaUrl || !/^https:\/\//.test(content.headerMediaUrl)) {
      return `The template "${template.name}" has a ${header.format.toLowerCase()} header; give its public https URL.`;
    }
  }
  const dynamic = template.buttons.filter((button) => button.dynamic).length;
  if ((content.buttonParams ?? []).length !== dynamic) {
    return `The template "${template.name}" has ${dynamic} link button(s) needing a value; this campaign gives ${(content.buttonParams ?? []).length}.`;
  }
  return null;
}

/** The template a campaign refers to, by id and language. */
export function findTemplate(
  templates: WhatsAppTemplate[],
  ref: WhatsAppContent['template'],
): WhatsAppTemplate | undefined {
  return templates.find(
    (template) => template.id === ref.id && template.language === ref.language,
  );
}
