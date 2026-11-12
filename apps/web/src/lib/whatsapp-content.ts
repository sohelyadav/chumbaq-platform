import type { WhatsAppContent, WhatsAppTemplate } from '@/hooks/use-whatsapp';

/** A campaign message with no template chosen yet. */
export function emptyContent(): WhatsAppContent {
  return { template: { id: '', name: '', language: 'en' }, bodyParams: [], buttonParams: [] };
}

/** Fresh content for a chosen template: one empty value per placeholder and dynamic button. */
export function fromTemplate(template: WhatsAppTemplate): WhatsAppContent {
  const media = template.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(template.header.format)
    ? (template.header.format.toLowerCase() as 'image' | 'video' | 'document')
    : null;
  return {
    template: {
      id: template.id,
      name: template.name,
      language: template.language,
      category: template.category,
      paramNames: template.paramNames,
    },
    bodyParams: Array.from({ length: template.bodyParamCount }, () => ''),
    headerText: template.header?.format === 'TEXT' && template.header.paramCount > 0 ? '' : null,
    headerMediaUrl: media ? '' : null,
    headerMediaType: media,
    buttonParams: template.buttons.filter((button) => button.dynamic).map(() => ''),
    previewText: template.bodyText,
  };
}

/**
 * Why this content cannot be sent, or null — the composer's copy of the
 * API's `templateProblem` (apps/api/src/modules/whatsapp/whatsapp-templates.ts),
 * so the button is disabled before the API has to say no. `template` is
 * undefined for a provider that cannot list templates.
 */
export function contentProblem(content: WhatsAppContent, template: WhatsAppTemplate | undefined): string | null {
  if (!content.template.id.trim()) return 'Choose a template.';
  if (!/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(content.template.language)) {
    return 'The language is a code such as en or en_US.';
  }
  if (content.bodyParams.some((value) => !value.trim())) return 'Fill in every value.';
  if (!template) return null;
  if (template.header?.format === 'TEXT' && template.header.paramCount > 0 && !content.headerText?.trim()) {
    return 'Fill in the header value.';
  }
  if (template.header && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(template.header.format)
    && !/^https:\/\/\S+$/.test(content.headerMediaUrl ?? '')) {
    return `Give the header ${template.header.format.toLowerCase()}'s public https URL.`;
  }
  if ((content.buttonParams ?? []).some((value) => !value.trim())) return 'Fill in every link button.';
  return null;
}

/** The template body with the values typed so far, numbered or named. */
export function fillPreview(bodyText: string, params: string[], names?: string[] | null): string {
  return bodyText.replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (match, key: string) => {
    const index = /^\d+$/.test(key) ? Number(key) - 1 : (names ?? []).indexOf(key);
    const value = index >= 0 ? params[index] : undefined;
    return value ? value : match;
  });
}
