import { readFileSync } from 'fs';
import path from 'path';
import staffConfig, { assertStaffProductionConfig, staffProductionProblems } from './staff.config';

const KEYS = [
  'ADMIN_API_PORT',
  'ADMIN_API_HOST',
  'ADMIN_APP_URL',
  'STAFF_WEBAUTHN_RP_ID',
  'STAFF_WEBAUTHN_ORIGINS',
  'STAFF_ACCESS_TOKEN_TTL',
  'STAFF_IDLE_TIMEOUT',
  'STAFF_SESSION_MAX_AGE',
  'STAFF_ENROLMENT_SESSION_TTL',
  'STAFF_COOKIE_SECURE',
];

describe('staffConfig', () => {
  const original = { ...process.env };
  afterEach(() => {
    process.env = { ...original };
  });
  const load = (env: Record<string, string> = {}) => {
    for (const key of KEYS) delete process.env[key];
    Object.assign(process.env, env);
    return staffConfig();
  };

  it('needs no variable at all', () => {
    expect(load()).toEqual({
      adminApiPort: 3011,
      adminApiHost: '127.0.0.1',
      adminAppUrl: 'https://localhost:5174',
      adminAppUrlSet: false,
      accessTtl: '10m',
      accessTtlMs: 10 * 60_000,
      idleTimeoutMs: 30 * 60_000,
      maxAgeMs: 8 * 3_600_000,
      enrolmentTtlMs: 15 * 60_000,
      cookieSecure: true,
      webauthn: { rpId: 'localhost', rpName: 'Chumbaq Admin', origins: ['https://localhost:5174'] },
    });
  });

  it('binds staff passkeys to the admin app host, apart from the customer app', () => {
    const config = load({ ADMIN_APP_URL: 'https://admin.chumbaq.com' });
    expect(config.webauthn.rpId).toBe('admin.chumbaq.com');
    expect(config.webauthn.origins).toEqual(['https://admin.chumbaq.com']);
    expect(config.adminAppUrlSet).toBe(true);
  });

  it('lets a deployment name its own relying party', () => {
    const config = load({
      STAFF_WEBAUTHN_RP_ID: 'chumbaq.com',
      STAFF_WEBAUTHN_ORIGINS: 'https://a.chumbaq.com, https://b.chumbaq.com',
    });
    expect(config.webauthn.rpId).toBe('chumbaq.com');
    expect(config.webauthn.origins).toEqual(['https://a.chumbaq.com', 'https://b.chumbaq.com']);
  });

  it('turns the Secure flag off only for the literal false', () => {
    expect(load({ STAFF_COOKIE_SECURE: 'false' }).cookieSecure).toBe(false);
    expect(load({ STAFF_COOKIE_SECURE: '0' }).cookieSecure).toBe(true);
    expect(load({ STAFF_COOKIE_SECURE: 'no' }).cookieSecure).toBe(true);
  });

  it('reads the port and host', () => {
    expect(load({ ADMIN_API_PORT: '3401', ADMIN_API_HOST: '0.0.0.0' })).toMatchObject({
      adminApiPort: 3401,
      adminApiHost: '0.0.0.0',
    });
    expect(() => load({ ADMIN_API_PORT: 'eleven' })).toThrow('ADMIN_API_PORT');
  });

  it('refuses an access token that outlives the idle limit', () => {
    expect(() => load({ STAFF_ACCESS_TOKEN_TTL: '31m' })).toThrow(
      'STAFF_ACCESS_TOKEN_TTL must not exceed STAFF_IDLE_TIMEOUT',
    );
    expect(() => load({ STAFF_ACCESS_TOKEN_TTL: '30m' })).not.toThrow();
  });

  it('refuses an idle limit past the absolute end', () => {
    expect(() => load({ STAFF_IDLE_TIMEOUT: '9h' })).toThrow(
      'STAFF_IDLE_TIMEOUT must not exceed STAFF_SESSION_MAX_AGE',
    );
  });

  it('refuses a duration it cannot read', () => {
    expect(() => load({ STAFF_SESSION_MAX_AGE: 'eight hours' })).toThrow('Cannot read the duration');
  });

  describe('staffProductionProblems', () => {
    const problems = (env: Record<string, string>) => staffProductionProblems(load(env));

    it('passes the defaults a deployment gets from ADMIN_APP_URL alone', () => {
      expect(problems({ ADMIN_APP_URL: 'https://admin.example.com' })).toEqual([]);
    });

    it('still requires ADMIN_APP_URL', () => {
      expect(problems({})).toEqual(['ADMIN_APP_URL is required for the admin API in production']);
    });

    it('accepts a relying party the admin host belongs to', () => {
      expect(
        problems({ ADMIN_APP_URL: 'https://admin.example.com', STAFF_WEBAUTHN_RP_ID: 'example.com' }),
      ).toEqual([]);
      expect(
        problems({ ADMIN_APP_URL: 'https://Admin.Example.com/', STAFF_WEBAUTHN_RP_ID: 'ADMIN.example.COM' }),
      ).toEqual([]);
    });

    it('refuses a relying party that is not the admin host', () => {
      // The deploy template's admin.chumbaq.com left in while nginx serves another host.
      const found = problems({
        ADMIN_APP_URL: 'https://admin.example.com',
        STAFF_WEBAUTHN_RP_ID: 'admin.chumbaq.com',
        STAFF_WEBAUTHN_ORIGINS: 'https://admin.example.com',
      });
      expect(found).toEqual([
        'STAFF_WEBAUTHN_RP_ID "admin.chumbaq.com" must be "admin.example.com" (the ADMIN_APP_URL host) or a domain it is under',
      ]);
    });

    it('refuses a look-alike suffix and a bare top-level domain', () => {
      expect(
        problems({ ADMIN_APP_URL: 'https://admin.badexample.com', STAFF_WEBAUTHN_RP_ID: 'example.com' }),
      ).toHaveLength(1);
      expect(problems({ ADMIN_APP_URL: 'https://admin.example.com', STAFF_WEBAUTHN_RP_ID: 'com' })).toHaveLength(1);
      expect(
        problems({ ADMIN_APP_URL: 'https://admin.example.com', STAFF_WEBAUTHN_RP_ID: '.example.com' }),
      ).toHaveLength(1);
    });

    it('refuses origins that leave out the admin app', () => {
      expect(
        problems({ ADMIN_APP_URL: 'https://admin.example.com', STAFF_WEBAUTHN_ORIGINS: 'https://admin.chumbaq.com' }),
      ).toContain('STAFF_WEBAUTHN_ORIGINS must include https://admin.example.com, the origin of ADMIN_APP_URL');
    });

    it('refuses an origin outside the relying party', () => {
      expect(
        problems({
          ADMIN_APP_URL: 'https://admin.example.com',
          STAFF_WEBAUTHN_ORIGINS: 'https://admin.example.com, https://evil.test',
        }),
      ).toEqual(['STAFF_WEBAUTHN_ORIGINS: https://evil.test is not on admin.example.com (STAFF_WEBAUTHN_RP_ID)']);
    });

    it('matches an IP address exactly, never by suffix', () => {
      // The browser refuses 0.0.5 as the relying party of 10.0.0.5.
      expect(
        problems({ ADMIN_APP_URL: 'https://10.0.0.5', STAFF_WEBAUTHN_RP_ID: '0.0.5' }),
      ).toEqual(['STAFF_WEBAUTHN_RP_ID "0.0.5" must be "10.0.0.5": an IP address only matches itself']);
      expect(problems({ ADMIN_APP_URL: 'https://10.0.0.5', STAFF_WEBAUTHN_RP_ID: '0.5' })).toHaveLength(1);
      expect(problems({ ADMIN_APP_URL: 'https://10.0.0.5' })).toEqual([]);
      // An origin on another IP that ends the same way is off the relying party too.
      expect(
        problems({
          ADMIN_APP_URL: 'https://10.0.0.5',
          STAFF_WEBAUTHN_RP_ID: '0.0.5',
          STAFF_WEBAUTHN_ORIGINS: 'https://10.0.0.5, https://20.0.0.5',
        }),
      ).toContain('STAFF_WEBAUTHN_ORIGINS: https://20.0.0.5 is not on 0.0.5 (STAFF_WEBAUTHN_RP_ID)');
    });

    it('says plainly that ADMIN_APP_URL cannot be this machine in production', () => {
      for (const url of [
        'https://localhost:5174',
        'https://localhost.:5174',
        'https://admin.localhost',
        'https://127.0.0.1',
        'https://[::1]',
        'https://[::]',
        'https://[::ffff:127.0.0.1]',
        'https://0.0.0.0',
      ]) {
        const found = problems({ ADMIN_APP_URL: url });
        expect(found).toHaveLength(1);
        expect(found[0]).toMatch(/^ADMIN_APP_URL cannot point at this machine/);
      }
    });
  });

  describe('assertStaffProductionConfig (the admin API boot gate)', () => {
    const mismatched = {
      ADMIN_APP_URL: 'https://admin.example.com',
      STAFF_WEBAUTHN_RP_ID: 'admin.chumbaq.com',
    };

    it('refuses a production boot with every problem in the message', () => {
      const staff = load(mismatched);
      expect(() => assertStaffProductionConfig('production', staff)).toThrow(
        'STAFF_WEBAUTHN_RP_ID "admin.chumbaq.com" must be "admin.example.com"',
      );
      expect(() => assertStaffProductionConfig('production', load({}))).toThrow(
        'ADMIN_APP_URL is required for the admin API in production',
      );
    });

    it('lets a matching production config boot', () => {
      expect(() =>
        assertStaffProductionConfig('production', load({ ADMIN_APP_URL: 'https://admin.example.com' })),
      ).not.toThrow();
    });

    it('leaves development and test on the localhost defaults', () => {
      for (const env of ['development', 'test', undefined]) {
        expect(() => assertStaffProductionConfig(env, load(mismatched))).not.toThrow();
        expect(() => assertStaffProductionConfig(env, load({}))).not.toThrow();
      }
    });

    // main-admin.ts boots Nest, so it is not run here; this pins that it calls the gate
    // with the configured NODE_ENV and exits on a refusal.
    it('is what main-admin.ts calls before listening', () => {
      const source = readFileSync(path.resolve(__dirname, '../main-admin.ts'), 'utf8');
      const gate = source.indexOf("assertStaffProductionConfig(config.get<string>('app.nodeEnv'), staff)");
      expect(gate).toBeGreaterThan(-1);
      expect(source.slice(gate, gate + 300)).toMatch(/catch[\s\S]*process\.exit\(1\)/);
      expect(gate).toBeLessThan(source.indexOf('app.listen('));
    });
  });
});
