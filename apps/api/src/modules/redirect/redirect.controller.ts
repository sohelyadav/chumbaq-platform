import {
  Controller,
  Get,
  Param,
  Req,
  Res,
  Headers,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { RedirectService, LinkUnavailableException, LINK_UNAVAILABLE_HTML } from './redirect.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { PlatformDetectorService } from './platform-detector.service';
import { TouchpointsService } from '../touchpoints/touchpoints.service';
import { TrackingConsentService } from '../consent/tracking-consent.service';
import { getClientIp } from '../../common/client-ip';
import { readCookie } from '../../common/cookies';
import { interstitialPolicy, STATIC_PAGE_POLICY } from '../../common/security-headers';

// NOTE: This controller intentionally has no prefix so its routes mount at the
// domain root (`/.well-known/...`, `/:shortCode`). Apple/Android only fetch
// AASA/assetlinks at the root, and short links must also live at the root.
// The matching paths are listed in main.ts setGlobalPrefix.exclude so they
// bypass the `/api` prefix. RedirectModule must remain the LAST import in
// app.module.ts so the wildcard `/:shortCode` does not shadow other routes.
/**
 * The JS SDK's device ID, which only arrives when a short link shares a host with a site
 * running the SDK: its cookie is set on that site, and nothing sets one on the short-link
 * domain. It comes from the browser, so it is checked here: one too long for the column
 * would fail the touchpoint's insert and lose the touchpoint.
 */
function readDeviceFingerprint(req: Request): string | undefined {
  const value = readCookie(req, 'chumbaq_did');
  return value && /^[A-Za-z0-9_-]{1,255}$/.test(value) ? value : undefined;
}

@Controller()
export class RedirectController {
  private readonly logger = new Logger(RedirectController.name);

  constructor(
    private readonly redirectService: RedirectService,
    private readonly analyticsService: AnalyticsService,
    private readonly platformDetector: PlatformDetectorService,
    private readonly touchpointsService: TouchpointsService,
    private readonly trackingConsent: TrackingConsentService,
  ) {}

  @Get('.well-known/apple-app-site-association')
  async appleAppSiteAssociation(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const domain = req.headers.host?.split(':')[0] || '';
    const aasa = await this.redirectService.getAppleAppSiteAssociation(domain);
    res.setHeader('Content-Type', 'application/json');
    res.json(aasa);
  }

  @Get('.well-known/assetlinks.json')
  async assetLinks(
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const domain = req.headers.host?.split(':')[0] || '';
    const links = await this.redirectService.getAssetLinks(domain);
    res.setHeader('Content-Type', 'application/json');
    res.json(links);
  }

  @Get(':shortCode/preview')
  async preview(@Param('shortCode') shortCode: string) {
    return this.redirectService.getLinkPreview(shortCode);
  }

  @Get(':shortCode')
  async redirect(
    @Param('shortCode') shortCode: string,
    @Headers('user-agent') userAgent: string,
    @Headers('referer') referrer: string,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    // Must be the same derivation the deferred matcher uses, or an install
    // never joins to its own click.
    const ip = getClientIp(req);

    let result: Awaited<ReturnType<RedirectService['handleRedirect']>>;
    try {
      result = await this.redirectService.handleRedirect(
        shortCode,
        userAgent || '',
        ip,
        referrer || '',
      );
    } catch (error) {
      // Whoever tapped a suspended tenant's link is a person in a browser, and
      // nothing below has run, so no click or touchpoint is recorded.
      if (error instanceof LinkUnavailableException) {
        res.setHeader('Content-Security-Policy', STATIC_PAGE_POLICY);
        res.status(404).type('html').send(LINK_UNAVAILABLE_HTML);
        return;
      }
      throw error;
    }

    if (result.type === 'interstitial' && result.html) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Security-Policy', interstitialPolicy(result.scriptNonce as string));
      res.send(result.html);
    } else {
      res.redirect(302, result.url!);
    }

    // Fire-and-forget click recording (don't block the response)
    const deviceInfo = result.deviceInfo;
    let redirectType = 'web_fallback';
    if (result.type === 'interstitial') {
      if (result.platform === 'ios') {
        redirectType = deviceInfo.deviceType === 'desktop' ? 'web_fallback' : 'app_deeplink';
      } else if (result.platform === 'android') {
        redirectType = 'app_deeplink';
      }
    }

    const deviceFingerprint = readDeviceFingerprint(req);

    this.analyticsService
      .recordClick({
        linkId: result.link.id,
        ipAddress: ip,
        userAgent: userAgent,
        referrer: referrer,
        platform: deviceInfo.platform,
        deviceType: deviceInfo.deviceType,
        os: deviceInfo.os,
        osVersion: deviceInfo.osVersion,
        browser: deviceInfo.browser,
        browserVersion: deviceInfo.browserVersion,
        redirectType,
        deviceFingerprint,
      })
      .catch((err) => {
        this.logger.error('Failed to record click event', err);
      });

    // Record touchpoint for multi-touch attribution. Not for a do-not-track
    // device: a touchpoint exists only to be credited to a person, which is
    // the profiling they refused. The click above is still counted, unlinked.
    const query = req.query as Record<string, string>;
    const projectId = result.link.projectId;
    this.recordTouchpointUnlessDoNotTrack(projectId, deviceFingerprint, {
      projectId,
      distinctId: undefined,
      deviceFingerprint,
      touchpointType: 'link_click',
      utmSource: query.utm_source || undefined,
      utmMedium: query.utm_medium || undefined,
      utmCampaign: query.utm_campaign || undefined,
      utmTerm: query.utm_term || undefined,
      utmContent: query.utm_content || undefined,
      linkId: result.link.id,
      referrer: referrer || undefined,
      platform: deviceInfo.platform,
      deviceType: deviceInfo.deviceType,
      country: undefined, // geo resolved async in analytics service
      ipAddress: ip,
    })
      .catch((err) => {
        this.logger.error('Failed to record touchpoint', err);
      });
  }

  private async recordTouchpointUnlessDoNotTrack(
    projectId: string,
    deviceFingerprint: string | undefined,
    params: Parameters<TouchpointsService['record']>[0],
  ): Promise<void> {
    if (
      deviceFingerprint &&
      (await this.trackingConsent.isDoNotTrack({ projectId, deviceFingerprint }))
    ) {
      this.trackingConsent.recordDrop('touchpoint');
      return;
    }
    await this.touchpointsService.record(params);
  }
}
