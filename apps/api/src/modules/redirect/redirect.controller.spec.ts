import { STATIC_PAGE_POLICY } from '../../common/security-headers';
import { RedirectController } from './redirect.controller';
import { RedirectService } from './redirect.service';

/**
 * Run through the real RedirectService, because what is under test is the
 * ordering between the two: the refusal has to reach the controller before it
 * records anything, and a stubbed service could only assert the stub's own
 * behaviour.
 */
describe('RedirectController for a suspended tenant', () => {
  const link = {
    id: 'link-1',
    shortCode: 'abc123',
    longUrl: 'https://example.com/destination',
    iosUrl: 'myapp://deep/path',
    androidUrl: null,
    isActive: true,
    expiresAt: null,
    projectId: 'proj-1',
    project: { id: 'proj-1' },
  };

  let suspendedProject: string | null;
  const analytics = { recordClick: jest.fn(async () => ({})) };
  const touchpoints = { record: jest.fn(async () => ({})) };
  let doNotTrackDevice: string | null;
  const trackingConsent = {
    isDoNotTrack: jest.fn(
      async ({ deviceFingerprint }: { deviceFingerprint?: string }) =>
        !!deviceFingerprint && deviceFingerprint === doNotTrackDevice,
    ),
    recordDrop: jest.fn(),
  };
  // The touchpoint waits on the do-not-track lookup after the response is sent.
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const platformDetector = {
    detect: jest.fn(() => ({ platform: 'web', deviceType: 'desktop' })),
  };
  let controller: RedirectController;

  // Headers only, as a real request is: nothing here parses cookies onto `req.cookies`.
  const request = (cookie?: string) =>
    ({ headers: cookie ? { cookie } : {}, query: {}, socket: {} }) as never;
  const response = () => {
    const res = { redirect: jest.fn(), send: jest.fn(), setHeader: jest.fn(), status: jest.fn(), type: jest.fn() };
    res.status.mockReturnValue(res);
    res.type.mockReturnValue(res);
    return res;
  };

  beforeEach(() => {
    jest.clearAllMocks();
    suspendedProject = null;
    doNotTrackDevice = null;
    const service = new RedirectService(
      { findOne: jest.fn(async () => ({ ...link })) } as never,
      {} as never,
      platformDetector as never,
      { isSuspended: async (id: string) => id === suspendedProject } as never,
    );
    controller = new RedirectController(
      service,
      analytics as never,
      platformDetector as never,
      touchpoints as never,
      trackingConsent as never,
    );
  });

  describe('the JS SDK device cookie', () => {
    // The SDK's real value and format: `generateUUID()` in chumbaq-js-sdk/src/index.ts.
    const DEVICE = '6f1c2a54-9b3e-4d7a-8c21-0e5f7a9b1c33';
    const recorded = async (cookie?: string) => {
      await controller.redirect('abc123', 'ua', '', request(cookie), response() as never);
      await settle();
      return {
        click: (analytics.recordClick.mock.calls.at(-1) as unknown as [{ deviceFingerprint?: string }])[0].deviceFingerprint,
        touchpoint: (touchpoints.record.mock.calls.at(-1) as unknown as [{ deviceFingerprint?: string }])[0].deviceFingerprint,
      };
    };

    it('reaches both the click and the touchpoint', async () => {
      expect(await recorded(`chumbaq_did=${DEVICE}`)).toEqual({ click: DEVICE, touchpoint: DEVICE });
    });

    it('is found among the other cookies a tenant’s site sets', async () => {
      const cookie = `_ga=GA1.1.1; chumbaq_ref=abc; chumbaq_did=${DEVICE}; theme=dark`;
      expect((await recorded(cookie)).click).toBe(DEVICE);
    });

    it.each([
      ['no cookies at all', undefined],
      ['another cookie ending in the same name', `x_chumbaq_did=${DEVICE}`],
      ['too long for the column, which would lose the touchpoint', `chumbaq_did=${'a'.repeat(256)}`],
      ['characters no device ID has', "chumbaq_did=a'%20OR%201=1"],
      ['an empty value', 'chumbaq_did='],
    ])('still records the click with no device for %s', async (_name, cookie) => {
      expect(await recorded(cookie)).toEqual({ click: undefined, touchpoint: undefined });
    });
  });

  describe('a do-not-track device', () => {
    const DEVICE = '6f1c2a54-9b3e-4d7a-8c21-0e5f7a9b1c33';

    it('records no touchpoint, and leaves the unlinked click to the analytics service', async () => {
      doNotTrackDevice = DEVICE;
      await controller.redirect('abc123', 'ua', '', request(`chumbaq_did=${DEVICE}`), response() as never);
      await settle();

      expect(trackingConsent.isDoNotTrack).toHaveBeenCalledWith({
        projectId: 'proj-1',
        deviceFingerprint: DEVICE,
      });
      expect(touchpoints.record).not.toHaveBeenCalled();
      expect(trackingConsent.recordDrop).toHaveBeenCalledWith('touchpoint');
      // The click is still recorded; AnalyticsService decides not to link it.
      expect(analytics.recordClick).toHaveBeenCalledTimes(1);
    });

    it('does not stop the touchpoint of a device that is not do-not-track', async () => {
      doNotTrackDevice = 'someone-else';
      await controller.redirect('abc123', 'ua', '', request(`chumbaq_did=${DEVICE}`), response() as never);
      await settle();
      expect(touchpoints.record).toHaveBeenCalledTimes(1);
    });
  });

  it('sends the interstitial with a policy naming the nonce its own script carries', async () => {
    const service = (controller as unknown as { redirectService: RedirectService }).redirectService;
    jest.spyOn(service, 'handleRedirect').mockResolvedValueOnce({
      type: 'interstitial',
      html: '<html></html>',
      scriptNonce: 'nonce123',
      link,
      platform: 'ios',
      deviceInfo: {},
    } as never);
    const res = response();

    await controller.redirect('abc123', 'ua', '', request(), res as never);

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Security-Policy',
      expect.stringContaining("script-src 'nonce-nonce123'"),
    );
    expect(res.send).toHaveBeenCalledWith('<html></html>');
  });

  it('records no click or touchpoint and sends the visitor nowhere', async () => {
    suspendedProject = 'proj-1';
    const res = response();

    await controller.redirect('abc123', 'ua', '', request(), res as never);

    expect(analytics.recordClick).not.toHaveBeenCalled();
    expect(touchpoints.record).not.toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
    // A person tapped this link, so they get a page and not a JSON error, and
    // it gives away neither destination.
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.setHeader).toHaveBeenCalledWith('Content-Security-Policy', STATIC_PAGE_POLICY);
    expect(res.type).toHaveBeenCalledWith('html');
    const page = res.send.mock.calls[0][0] as string;
    expect(page).toContain('This link is unavailable');
    expect(page).not.toContain(link.longUrl);
    expect(page).not.toContain(link.iosUrl);
  });

  it('redirects and records for an active tenant', async () => {
    const res = response();

    await controller.redirect('abc123', 'ua', '', request(), res as never);
    await settle();

    expect(res.redirect).toHaveBeenCalledWith(302, 'https://example.com/destination');
    expect(analytics.recordClick).toHaveBeenCalledTimes(1);
    expect(touchpoints.record).toHaveBeenCalledTimes(1);
  });
});
