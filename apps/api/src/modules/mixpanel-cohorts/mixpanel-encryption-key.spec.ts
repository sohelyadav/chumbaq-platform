/**
 * Without MIXPANEL_ENCRYPTION_KEY the integration is unavailable on this server, which
 * `mixpanel/configure` must say as a 503, not a 500. The key is read once and cached at
 * module level, so each case loads a fresh copy of the service.
 */
describe('Mixpanel encryption key', () => {
  const saved = process.env.MIXPANEL_ENCRYPTION_KEY;
  afterEach(() => {
    if (saved === undefined) delete process.env.MIXPANEL_ENCRYPTION_KEY;
    else process.env.MIXPANEL_ENCRYPTION_KEY = saved;
  });

  function serviceWithEmptyConfig() {
    let Service: typeof import('./mixpanel-cohorts.service').MixpanelCohortsService;
    jest.isolateModules(() => {
      Service = require('./mixpanel-cohorts.service').MixpanelCohortsService;
    });
    const row: Record<string, unknown> | null = null;
    const configs = {
      findOne: jest.fn().mockResolvedValue(row),
      save: jest.fn(),
      create: jest.fn((v) => v),
    };
    const configRepo = {
      manager: {
        transaction: (fn: (m: unknown) => unknown) => fn({ getRepository: () => configs }),
      },
    };
    return new Service!(configRepo as never, {} as never, {} as never, {} as never, { record: jest.fn() } as never);
  }

  const dto = { serviceAccountUsername: 'u', serviceAccountPassword: 'p', mixpanelProjectId: '1' };
  const ctx = { ipAddress: null, userAgent: null } as never;

  it.each([
    ['unset', undefined],
    ['too short', 'short'],
  ])('answers 503 when the key is %s', async (_label, value) => {
    if (value === undefined) delete process.env.MIXPANEL_ENCRYPTION_KEY;
    else process.env.MIXPANEL_ENCRYPTION_KEY = value;
    const err = await serviceWithEmptyConfig().configure('p1', dto as never, 'u1', ctx).catch((e) => e);
    // isolateModules loads its own copy of Nest, so compare the status, not the class.
    expect(err.getStatus()).toBe(503);
    expect(err.message).not.toContain('MIXPANEL_ENCRYPTION_KEY');
  });
});
