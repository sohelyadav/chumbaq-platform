import webauthnConfig from './webauthn.config';

describe('webauthnConfig', () => {
  const original = { ...process.env };
  // NODE_ENV is part of the rule, so each test sets it rather than inheriting jest's.
  afterEach(() => {
    process.env = { ...original };
  });
  const load = (env: Record<string, string>) => {
    for (const key of ['NODE_ENV', 'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGINS', 'PASSKEYS_FOR_TENANTS', 'SUPER_ADMIN_ALLOW_SYNCED_PASSKEYS', 'SUPER_ADMIN_PASSKEY_REQUIRED']) {
      delete process.env[key];
    }
    Object.assign(process.env, env);
    return webauthnConfig();
  };

  it('binds passkeys to the dashboard hostname, and that origin only', () => {
    const config = load({ APP_URL: 'https://app.example.com/some/path' });
    expect(config.rpId).toBe('app.example.com');
    expect(config.origins).toEqual(['https://app.example.com']);
  });

  it('accepts the local dev dashboard only when running on localhost', () => {
    expect(load({ APP_URL: 'http://localhost:3010' }).origins).toContain('https://localhost:5173');
    expect(load({ APP_URL: 'https://app.example.com' }).origins).not.toContain('https://localhost:5173');
  });

  it('lets a deployment name its own', () => {
    const config = load({
      APP_URL: 'https://app.example.com',
      WEBAUTHN_RP_ID: 'example.com',
      WEBAUTHN_ORIGINS: 'https://a.example.com, https://b.example.com',
    });
    expect(config.rpId).toBe('example.com');
    expect(config.origins).toEqual(['https://a.example.com', 'https://b.example.com']);
  });

  it('keeps the other switches off unless set', () => {
    expect(load({ APP_URL: 'https://app.example.com' })).toMatchObject({
      forTenants: false,
      superAdminAllowSynced: false,
    });
  });

  it('requires super admin passkeys by default', () => {
    expect(load({ APP_URL: 'https://app.example.com', NODE_ENV: 'development' }).superAdminPasskeyRequired).toBe(true);
    expect(load({ APP_URL: 'https://app.example.com', NODE_ENV: 'development', SUPER_ADMIN_PASSKEY_REQUIRED: 'no' }).superAdminPasskeyRequired).toBe(true);
  });

  it('lets only a non-production run turn super admin passkeys off', () => {
    expect(load({ APP_URL: 'https://app.example.com', NODE_ENV: 'development', SUPER_ADMIN_PASSKEY_REQUIRED: 'false' }).superAdminPasskeyRequired).toBe(false);
    expect(load({ APP_URL: 'https://app.example.com', NODE_ENV: 'production', SUPER_ADMIN_PASSKEY_REQUIRED: 'false' }).superAdminPasskeyRequired).toBe(true);
  });

  it('refuses to start with no APP_URL', () => {
    delete process.env.APP_URL;
    expect(() => webauthnConfig()).toThrow('APP_URL');
  });
});
