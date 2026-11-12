import { previewWhatsApp, renderParam, renderWhatsApp } from './whatsapp-rendering';
import { templateProblem } from './whatsapp-templates';
import { WhatsAppTemplate } from './providers/whatsapp-provider';

describe('renderParam', () => {
  it('personalises with a fallback', () => {
    expect(renderParam('{{firstName|there}}', { firstName: 'Priya' })).toBe('Priya');
    expect(renderParam('{{firstName|there}}', {})).toBe('there');
  });

  it('removes what Meta refuses in a parameter: newlines, tabs, runs of spaces', () => {
    expect(renderParam('{{firstName}}', { firstName: 'A\n\tB     C' })).toBe('A B C');
  });

  it('never sends an empty parameter', () => {
    expect(renderParam('{{firstName}}', {})).toBe('-');
  });
});

describe('renderWhatsApp', () => {
  it('URL-encodes personalisation in a button suffix so it cannot add query parameters', () => {
    const message = renderWhatsApp({
      content: {
        template: { id: 't', name: 't', language: 'en' },
        bodyParams: ['x'],
        buttonParams: ['ref={{firstName}}'],
      },
      identity: { firstName: 'A&b=c d' },
      campaignId: null,
      identityId: null,
    });
    expect(message.buttonParams).toEqual(['ref=A%26b%3Dc%20d']);
  });

  it('works out a media header type when the template did not say', () => {
    const message = renderWhatsApp({
      content: { template: { id: 't', name: 't', language: 'en' }, bodyParams: [], headerMediaUrl: 'https://x/menu.pdf' },
      identity: null,
      campaignId: null,
      identityId: null,
    });
    expect(message.headerMediaType).toBe('document');
  });
});

describe('previewWhatsApp', () => {
  it('fills numbered placeholders and leaves missing ones visible', () => {
    expect(previewWhatsApp('Hi {{1}}, {{2}} off. {{3}}', ['Priya', '20%'])).toBe('Hi Priya, 20% off. {{3}}');
  });
});

describe('templateProblem', () => {
  const template: WhatsAppTemplate = {
    id: 'promo', name: 'promo', language: 'en', category: 'MARKETING', status: 'APPROVED',
    bodyText: 'Hi {{1}}, {{2}} off', bodyParamCount: 2, paramNames: null,
    header: { format: 'IMAGE', text: null, paramCount: 0 },
    buttons: [{ type: 'URL', text: 'Shop', dynamic: true }],
  };
  const content = {
    template: { id: 'promo', name: 'promo', language: 'en' },
    bodyParams: ['a', 'b'],
    headerMediaUrl: 'https://cdn/x.png',
    buttonParams: ['SALE'],
  };

  it('accepts content that matches the approved template', () => {
    expect(templateProblem(content, template)).toBeNull();
  });

  it('names each mismatch WhatsApp would refuse', () => {
    expect(templateProblem(content, undefined)).toMatch(/not found/);
    expect(templateProblem(content, { ...template, status: 'PAUSED' })).toMatch(/paused/);
    expect(templateProblem({ ...content, bodyParams: ['a'] }, template)).toMatch(/2 body value/);
    expect(templateProblem({ ...content, headerMediaUrl: 'http://cdn/x.png' }, template)).toMatch(/https URL/);
    expect(templateProblem({ ...content, buttonParams: [] }, template)).toMatch(/link button/);
  });
});
