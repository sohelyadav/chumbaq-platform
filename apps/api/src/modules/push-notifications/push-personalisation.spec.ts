import {
  pickTranslation,
  hasPersonalisation,
  renderTemplate,
  personalise,
  PERSONALISATION_FIELDS,
} from './push-personalisation';

const person = {
  firstName: 'Priya',
  lastName: 'Sharma',
  city: 'Pune',
  country: 'India',
  traits: { plan: 'gold', points: 240 },
} as any;

describe('push personalisation', () => {
  describe('hasPersonalisation', () => {
    it('detects a token in any of the supplied strings', () => {
      expect(hasPersonalisation('Hello', 'Hi {{firstName}}')).toBe(true);
    });

    it('is false for plain copy', () => {
      expect(hasPersonalisation('Hello there', 'No tokens here')).toBe(false);
    });

    it('is false for null and undefined', () => {
      expect(hasPersonalisation(null, undefined)).toBe(false);
    });

    it('does not get stuck between calls', () => {
      // The pattern is a module-level regex with /g; without resetting
      // lastIndex the second call would start mid-string and miss the token.
      const text = 'Hi {{firstName}}';
      expect(hasPersonalisation(text)).toBe(true);
      expect(hasPersonalisation(text)).toBe(true);
    });
  });

  describe('renderTemplate', () => {
    it('substitutes a known field', () => {
      expect(renderTemplate('Hi {{firstName}}!', person)).toBe('Hi Priya!');
    });

    it('tolerates whitespace inside the braces', () => {
      expect(renderTemplate('Hi {{ firstName }}!', person)).toBe('Hi Priya!');
    });

    it('substitutes several tokens in one string', () => {
      expect(
        renderTemplate('{{firstName}} {{lastName}} of {{city}}', person),
      ).toBe('Priya Sharma of Pune');
    });

    it('reads app-specific values out of traits', () => {
      expect(renderTemplate('You are {{trait.plan}}', person)).toBe(
        'You are gold',
      );
      expect(renderTemplate('{{trait.points}} points', person)).toBe(
        '240 points',
      );
    });

    it('uses the fallback when a field is missing', () => {
      expect(renderTemplate('Hi {{firstName|there}}!', {} as any)).toBe(
        'Hi there!',
      );
    });

    it('uses the fallback when a field is empty rather than absent', () => {
      expect(
        renderTemplate('Hi {{firstName|there}}!', { firstName: '' } as any),
      ).toBe('Hi there!');
    });

    it('never leaves raw template syntax in the output', () => {
      // Shipping "{{firstName}}" to a lock screen is worse than a generic
      // greeting, so an unresolved token with no fallback renders empty.
      expect(renderTemplate('Hi {{firstName}}!', null)).toBe('Hi !');
      expect(renderTemplate('Hi {{unknownField}}!', person)).toBe('Hi !');
    });

    it('refuses fields outside the allow-list', () => {
      // The identity row also holds ipAddress, userAgent and fingerprints. A
      // marketer must not be able to render those by guessing a name.
      const withPii = { ...person, ipAddress: '203.0.113.9' } as any;
      expect(renderTemplate('{{ipAddress}}', withPii)).toBe('');
      expect(renderTemplate('{{deviceFingerprint}}', withPii)).toBe('');
      expect(PERSONALISATION_FIELDS).not.toContain('ipAddress' as never);
    });

    it('renders the email address now that identities carry one', () => {
      const withEmail = { ...person, email: 'priya@example.com' } as any;
      expect(renderTemplate('Sent to {{email}}', withEmail)).toBe(
        'Sent to priya@example.com',
      );
    });

    it('escapes substituted values but not the authored fallback', () => {
      const hostile = { ...person, firstName: '<img src=x onerror=alert(1)>' } as any;
      const escape = (v: string) => v.replace(/</g, '&lt;').replace(/>/g, '&gt;');
      expect(renderTemplate('Hi {{firstName}}', hostile, escape)).toBe(
        'Hi &lt;img src=x onerror=alert(1)&gt;',
      );
      expect(renderTemplate('Hi {{lastName|<b>there</b>}}', {} as any, escape)).toBe(
        'Hi <b>there</b>',
      );
    });

    it('leaves copy without tokens untouched', () => {
      expect(renderTemplate('Flash sale today', person)).toBe(
        'Flash sale today',
      );
    });
  });

  describe('personalise', () => {
    it('tidies punctuation left by an empty substitution', () => {
      // "Hi {{firstName}}, welcome" with no name must not become "Hi , welcome".
      expect(personalise('Hi {{firstName}}, welcome', null)).toBe('Hi, welcome');
    });

    it('collapses doubled spaces from a vanished token', () => {
      expect(personalise('Hey {{firstName}} come back', null)).toBe(
        'Hey come back',
      );
    });

    it('keeps normal punctuation intact when the value resolves', () => {
      expect(personalise('Hi {{firstName}}, welcome', person)).toBe(
        'Hi Priya, welcome',
      );
    });

    it('returns undefined for empty input so optional fields stay optional', () => {
      expect(personalise(undefined, person)).toBeUndefined();
      expect(personalise('', person)).toBeUndefined();
    });
  });

  describe('pickTranslation', () => {
    const translations = {
      hi: { title: 'नमस्ते', body: 'हिंदी' },
      'pt-BR': { title: 'Olá Brasil' },
      pt: { title: 'Olá' },
    };

    it('matches the exact tag before the base language', () => {
      expect(
        pickTranslation(translations, { language: 'pt-BR' })!.title,
      ).toBe('Olá Brasil');
    });

    it('falls back to the base language when the region is unknown', () => {
      // A Portuguese speaker in Portugal should get generic Portuguese rather
      // than the campaign's default language.
      expect(pickTranslation(translations, { language: 'pt-PT' })!.title).toBe(
        'Olá',
      );
    });

    it('is case and separator insensitive', () => {
      expect(pickTranslation(translations, { language: 'PT_br' })!.title).toBe(
        'Olá Brasil',
      );
    });

    it('prefers language over locale', () => {
      // A device can report en-IN as its locale while the user reads Hindi.
      expect(
        pickTranslation(translations, { language: 'hi', locale: 'en-IN' })!.title,
      ).toBe('नमस्ते');
    });

    it('uses locale when no language is known', () => {
      expect(pickTranslation(translations, { locale: 'hi-IN' })!.title).toBe(
        'नमस्ते',
      );
    });

    it('returns null for a language with no translation', () => {
      // The campaign's own copy is used instead — an untranslated language
      // must still receive the campaign, not nothing.
      expect(pickTranslation(translations, { language: 'ja' })).toBeNull();
    });

    it('returns null when the identity is unknown', () => {
      expect(pickTranslation(translations, null)).toBeNull();
    });

    it('ignores an empty translation entry', () => {
      expect(
        pickTranslation({ ja: {} }, { language: 'ja' }),
      ).toBeNull();
    });
  });
});
