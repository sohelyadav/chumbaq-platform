import { formatFrom, headerSafe, htmlToText, renderEmail } from './email-rendering';

const sender = {
  fromEmail: 'hi@shop.example',
  fromName: 'Shop',
  replyTo: null,
  postalAddress: '12 MG Road\nBengaluru 560001',
};
const URL = 'https://api.example/api/email/unsubscribe?p=1&e=x&s=y';

const render = (over: Partial<Parameters<typeof renderEmail>[0]> = {}) =>
  renderEmail({
    content: { subject: 'Hi {{firstName|there}}', html: '<html><body><p>Hello {{firstName}}</p></body></html>' },
    identity: { firstName: 'Priya' } as never,
    sender,
    unsubscribeUrl: URL,
    tags: { chumbaq_campaign_id: 'c1' },
    ...over,
  });

describe('renderEmail', () => {
  it('personalises the subject and body', () => {
    const message = render();
    expect(message.subject).toBe('Hi Priya');
    expect(message.html).toContain('<p>Hello Priya</p>');
  });

  it('escapes person data in HTML so a trait cannot inject markup', () => {
    const message = render({
      identity: { firstName: '<img src=x onerror=alert(1)>' } as never,
    });
    expect(message.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(message.html).not.toContain('<img src=x');
  });

  it('strips line breaks from a personalised subject, which would inject headers', () => {
    const message = render({
      identity: { firstName: 'Priya\r\nBcc: victim@example.com' } as never,
    });
    expect(message.subject).not.toMatch(/[\r\n]/);
  });

  it('always sends one-click unsubscribe headers', () => {
    expect(render().headers).toEqual({
      'List-Unsubscribe': `<${URL}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('adds an unsubscribe link and the postal address to the footer', () => {
    const { html, text } = render();
    expect(html).toContain('Unsubscribe</a>');
    expect(html).toContain('href="https://api.example/api/email/unsubscribe?p=1&amp;e=x&amp;s=y"');
    expect(html).toContain('12 MG Road<br>Bengaluru 560001');
    // Inside the body, not after it.
    expect(html.indexOf('12 MG Road')).toBeLessThan(html.indexOf('</body>'));
    expect(text).toContain(`Unsubscribe: ${URL}`);
  });

  it('puts the link where the author placed it, and does not add a second', () => {
    const { html } = render({
      content: {
        subject: 'Hi',
        html: '<p><a href="{{unsubscribe_url}}">Leave</a></p>',
      },
    });
    expect(html).toContain('<a href="https://api.example/api/email/unsubscribe?p=1&amp;e=x&amp;s=y">Leave</a>');
    expect(html).not.toContain('>Unsubscribe</a>');
    // The postal address is still required.
    expect(html).toContain('12 MG Road');
  });

  it('places the preheader just inside the body, hidden', () => {
    const { html } = render({
      content: { subject: 'Hi', html: '<body><p>Main</p></body>', preheader: 'Your offer inside' },
    });
    expect(html).toMatch(/^<body><div style="display:none[^"]*">Your offer inside/);
  });

  it('derives the text part from the HTML when none was written', () => {
    const { text } = render({
      content: {
        subject: 'Hi',
        html: '<style>p{}</style><h1>Sale</h1><p>See <a href="https://shop.example/s">the deals</a></p>',
      },
    });
    expect(text).toContain('Sale');
    expect(text).toContain('the deals (https://shop.example/s)');
    expect(text).not.toContain('p{}');
  });
});

describe('helpers', () => {
  it('quotes a display name that needs it', () => {
    expect(formatFrom({ fromEmail: 'a@b.co', fromName: 'Shop "Best"' })).toBe(
      '"Shop \\"Best\\"" <a@b.co>',
    );
    expect(formatFrom({ fromEmail: 'a@b.co', fromName: null })).toBe('a@b.co');
  });

  it('flattens control characters in header values', () => {
    expect(headerSafe('a\r\nb\tc')).toBe('a b c');
  });

  it('keeps link targets when converting to text', () => {
    expect(htmlToText('<a href="https://x.example">https://x.example</a>')).toBe('https://x.example');
  });
});
