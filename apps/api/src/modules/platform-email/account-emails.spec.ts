import { accountLink, mauNoticeEmail, paymentHaltedEmail, projectInviteEmail, safeDisplayName } from './account-emails';

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

describe('billing emails', () => {
  const user = { email: 'owner@example.com', name: 'Asha <b>Rao</b>' };
  const link = accountLink('https://app.example', '/account/billing');

  describe('mauNoticeEmail', () => {
    const build = (level: 80 | 100) =>
      mauNoticeEmail(user, { level, mau: 2600, limit: 2500, planName: 'Team <b>plan</b>', month: '2026-11-01' }, link);

    it('says the limit was passed at 100%, and that nothing is blocked', () => {
      const email = build(100);
      expect(email.to).toBe('owner@example.com');
      expect(email.subject).toBe("Your apps passed this month's active device limit");
      for (const part of [email.html, email.text]) {
        expect(part).toContain('2,600');
        expect(part).toContain('2,500');
        expect(part).toContain('November 2026');
        expect(part).toContain('Nothing is blocked');
        expect(part).toContain('https://app.example/account/billing');
      }
    });

    it('says 80% at the first level', () => {
      expect(build(80).subject).toBe("Your apps are at 80% of this month's active devices");
    });

    it('escapes the plan and person names in the HTML part', () => {
      const email = build(100);
      expect(email.html).not.toContain('<b>');
      expect(email.html).toContain('Team &lt;b&gt;plan&lt;/b&gt;');
      expect(email.html).toContain('Asha &lt;b&gt;Rao&lt;/b&gt;');
      expect(email.text).toContain('Team <b>plan</b>');
    });

    it('links only to the app URL it is given', () => {
      expect(build(100).html).toMatch(/href="https:\/\/app\.example\/account\/billing"/);
    });
  });

  describe('paymentHaltedEmail', () => {
    const email = paymentHaltedEmail(user, new Date('2026-12-01T10:00:00Z'), link);

    it('says when the plan limits end, and that only new projects and invitations are affected', () => {
      expect(email.subject).toBe('Your payment did not go through');
      for (const part of [email.html, email.text]) {
        expect(part).toContain('Tue, 01 Dec 2026 10:00:00 UTC');
        expect(part).toContain('new projects and invitations');
        expect(part).toContain('https://app.example/account/billing');
      }
    });

    it('escapes the name in the HTML part', () => {
      expect(email.html).not.toContain('<b>');
      expect(email.html.startsWith('<p>Hi Asha &lt;b&gt;Rao&lt;/b&gt;,</p>')).toBe(true);
    });
  });
});
