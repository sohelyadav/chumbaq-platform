import { accountLink, projectInviteEmail, safeDisplayName } from './account-emails';

describe('accountLink', () => {
  it('puts the token in the fragment, which browsers never send to a server', () => {
    const url = new URL(accountLink('https://app.example', '/reset-password', 'abc_-123'));

    expect(url.pathname).toBe('/reset-password');
    expect(url.search).toBe('');
    expect(url.hash).toBe('#token=abc_-123');
  });

  it('encodes a token that is not URL-safe', () => {
    expect(accountLink('https://app.example', '/verify-email', 'a&b=c#d')).toBe(
      'https://app.example/verify-email#token=a%26b%3Dc%23d',
    );
  });

  it('leaves a link without a token bare, and drops trailing slashes from the base', () => {
    expect(accountLink('https://app.example//', '/forgot-password')).toBe(
      'https://app.example/forgot-password',
    );
  });
});

describe('projectInviteEmail', () => {
  const link = accountLink('https://app.example', '/invite', 'tok_-123');
  const build = (projectName: string, inviterName: string) =>
    projectInviteEmail('sam@example.com', {
      projectName,
      inviterName,
      role: 'admin',
      link,
      expiresAt: new Date('2026-11-15T10:00:00Z'),
    });

  it('names the project, the inviter and the role, and links with the token in the fragment', () => {
    const email = build('Acme app', 'Priya');

    expect(email.to).toBe('sam@example.com');
    for (const part of [email.html, email.text]) {
      expect(part).toContain('Acme app');
      expect(part).toContain('Priya');
      expect(part).toContain('admin');
      expect(part).toContain('https://app.example/invite#token=tok_-123');
      expect(part).not.toContain('?token=');
    }
    expect(email.text).toContain('Sun, 15 Nov 2026 10:00:00 UTC');
  });

  it('escapes the project and inviter names in the HTML part', () => {
    const email = build('<script>alert("p")<script>', '<script>alert("i")<script>');

    expect(email.html).not.toContain('<script');
    expect(email.html).toContain('&lt;script&gt;alert(&quot;p&quot;)&lt;script&gt;');
    expect(email.html).toContain('&lt;script&gt;alert(&quot;i&quot;)&lt;script&gt;');
    expect(email.text).toContain('<script>alert("p")<script>');
  });

  it('keeps names out of the subject, so a tenant cannot write the headline of mail from Chumbaq', () => {
    expect(build('Urgent: verify your bank', 'Support').subject).toBe('You have been invited to a Chumbaq project');
  });
});

describe('safeDisplayName', () => {
  it.each([
    ['Visit https://evil.com now', 'Visit now'],
    ['acme.io', ''],
    ['Go to www.evil.example today', 'Go to today'],
    ['see a.b.co/login', 'see'],
    ['x_evil.com', ''],
    ['_evil.com', ''],
    ['Acme_evil.com/login', ''],
    ['ftp://files.example x', 'x'],
    ['mail me at bob@evil.com', 'mail me at'],
    ['  Acme   Mobile  ', 'Acme Mobile'],
    ['evil_.com', ''],
    ['example。com', ''],
    ['example．com', ''],
    ['example｡com', ''],
    ['example․com', ''],
    ['ｅｘａｍｐｌｅ．ｃｏｍ', ''],
    ['x@y', ''],
    ['http:x', ''],
    ['a/b', ''],
    ['пример.рф', ''],
    ['Acme пример.рф Inc', 'Acme Inc'],
    ['Acme Inc', 'Acme Inc'],
    ["Sam O'Neil", "Sam O'Neil"],
    ['Acme Inc.', 'Acme'],
    ['Version 2.1 app', 'Version app'],
    ['J.R. Smith', 'Smith'],
    ['<script>alert(1)<script>', '<script>alert(1)<script>'],
    ['<script>alert(1)</script>', ''],
  ])('%j → %j', (input, output) => {
    expect(safeDisplayName(input)).toBe(output);
  });

  it('cuts anything past 60 characters with an ellipsis', () => {
    const out = safeDisplayName('x'.repeat(100));
    expect(out).toBe(`${'x'.repeat(60)}…`);
    expect(safeDisplayName('y'.repeat(60))).toBe('y'.repeat(60));
  });

  it('cuts a 70-character plain name to 60 characters plus an ellipsis', () => {
    const name = 'Acme '.repeat(14).trim();
    expect(name.length).toBe(69);
    expect(safeDisplayName(`${name}x`)).toBe(`${`${name}x`.slice(0, 60)}…`);
  });

  it('never splits a surrogate pair at the cut', () => {
    const out = safeDisplayName(`${'a'.repeat(59)}😀${'b'.repeat(10)}`);
    expect(out).toBe(`${'a'.repeat(59)}😀…`);
    expect([...out].length).toBe(61);
    expect(out).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });
});

describe('projectInviteEmail with names that are links', () => {
  it('drops the link and falls back to "Someone" and "a project" when nothing is left', () => {
    const email = projectInviteEmail('sam@example.com', {
      projectName: 'acme.io',
      inviterName: 'https://evil.com',
      role: 'member',
      link: 'https://app.example/invite#token=t',
      expiresAt: new Date('2026-11-15T10:00:00Z'),
    });
    for (const part of [email.html, email.text]) {
      expect(part).toContain('Someone invited you to join a project on Chumbaq as a member.');
      expect(part).not.toContain('evil');
      expect(part).not.toContain('acme.io');
    }
  });

  it('caps long names at 60 characters (plus an ellipsis) in the email', () => {
    const email = projectInviteEmail('sam@example.com', {
      projectName: 'P'.repeat(80),
      inviterName: 'I'.repeat(80),
      role: 'admin',
      link: 'https://app.example/invite#token=t',
      expiresAt: new Date('2026-11-15T10:00:00Z'),
    });
    expect(email.text).toContain(`${'I'.repeat(60)}… invited you to join the project "${'P'.repeat(60)}…"`);
    expect(email.text).not.toContain('P'.repeat(61));
  });
});
