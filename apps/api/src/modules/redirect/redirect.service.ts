import { randomBytes } from 'crypto';
import { Injectable, NotFoundException, Inject, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LinkEntity } from '../links/entities/link.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { PlatformDetectorService, DeviceInfo } from './platform-detector.service';
import { LinkVariantsService } from '../links/link-variants.service';
import { ProjectSuspensionService } from '../projects/project-suspension.service';

export interface RedirectResult {
  type: 'redirect' | 'interstitial';
  url?: string;
  html?: string;
  /** The nonce on the interstitial's script, for its Content-Security-Policy. */
  scriptNonce?: string;
  link: LinkEntity;
  platform: string;
  deviceInfo: DeviceInfo;
  variantId?: string;
}

/** Tells the controller to answer a person, not an API client. See its handler. */
export class LinkUnavailableException extends NotFoundException {
  constructor() {
    super('Link is no longer active');
  }
}

export const LINK_UNAVAILABLE_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>Link unavailable</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;text-align:center;padding:24px;color:#18181b}h1{font-size:20px;margin:0 0 8px}p{margin:0;color:#52525b}</style>
</head><body><main><h1>This link is unavailable</h1><p>It may have been turned off by its owner.</p></main></body></html>`;

@Injectable()
export class RedirectService {
  constructor(
    @InjectRepository(LinkEntity)
    private readonly linkRepository: Repository<LinkEntity>,
    @InjectRepository(ProjectEntity)
    private readonly projectRepository: Repository<ProjectEntity>,
    private readonly platformDetector: PlatformDetectorService,
    private readonly suspension: ProjectSuspensionService,
    @Optional() @Inject(LinkVariantsService) private readonly linkVariantsService?: LinkVariantsService,
  ) {}

  async handleRedirect(
    shortCode: string,
    userAgent: string,
    ip: string,
    referrer: string,
  ): Promise<RedirectResult> {
    const link = await this.linkRepository.findOne({
      where: { shortCode },
      relations: ['project'],
    });

    if (!link) {
      throw new NotFoundException('Link not found');
    }

    if (!link.isActive) {
      throw new NotFoundException('Link is no longer active');
    }

    if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
      throw new NotFoundException('Link has expired');
    }

    // Answered exactly as an inactive link is, and thrown before the controller
    // gets a result, so no click or touchpoint is recorded. Nothing caches a
    // redirect (a 302, no Cache-Control), so this applies from the next request.
    if (await this.suspension.isSuspended(link.projectId)) {
      throw new LinkUnavailableException();
    }

    const deviceInfo = this.platformDetector.detect(userAgent);
    const project = link.project;

    // A/B Testing: select variant if available
    let variantId: string | undefined;
    if (this.linkVariantsService) {
      const variant = await this.linkVariantsService.selectVariant(link.id);
      if (variant) {
        variantId = variant.id;
        // Override link URLs with variant URLs
        link.longUrl = variant.longUrl;
        if (variant.iosUrl) link.iosUrl = variant.iosUrl;
        if (variant.androidUrl) link.androidUrl = variant.androidUrl;
      }
    }

    // iOS with deep link configured
    if (deviceInfo.platform === 'ios' && link.iosUrl) {
      const scriptNonce = randomBytes(16).toString('base64');
      const html = this.getInterstitialHtml(link, project, 'ios', deviceInfo, scriptNonce);
      return { type: 'interstitial', html, scriptNonce, link, platform: 'ios', deviceInfo, variantId };
    }

    // Android with deep link configured
    if (deviceInfo.platform === 'android' && link.androidUrl) {
      const scriptNonce = randomBytes(16).toString('base64');
      const html = this.getInterstitialHtml(link, project, 'android', deviceInfo, scriptNonce);
      return { type: 'interstitial', html, scriptNonce, link, platform: 'android', deviceInfo, variantId };
    }

    // Desktop or no deep link configured
    return {
      type: 'redirect',
      url: link.longUrl,
      link,
      platform: deviceInfo.platform,
      deviceInfo,
      variantId,
    };
  }

  getInterstitialHtml(
    link: LinkEntity,
    project: ProjectEntity,
    platform: 'ios' | 'android',
    deviceInfo: DeviceInfo,
    scriptNonce: string,
  ): string {
    const ogTitle = link.ogTitle || link.title || '';
    const ogDescription = link.ogDescription || '';
    const ogImageUrl = link.ogImageUrl || '';
    const shortCode = link.shortCode;
    // Serialize deep link params for safe embedding inside a <script> block.
    // We use a separate <script type="application/json"> element so the JSON
    // payload is parsed at runtime rather than evaluated as JavaScript. The
    // only escaping needed is replacing `<` so a malicious string literal
    // cannot break out of the script tag.
    const deepLinkParamsJson = (link.deepLinkParams
      ? JSON.stringify(link.deepLinkParams)
      : '{}'
    ).replace(/</g, '\\u003c');

    let deepLinkUrl: string;
    let fallbackUrl: string;

    if (platform === 'ios') {
      deepLinkUrl = link.iosUrl;
      fallbackUrl =
        link.iosFallbackUrl ||
        (project && project.iosAppStoreUrl) ||
        link.longUrl;
    } else {
      // Build intent:// URL for Android
      if (project && project.androidPackageName) {
        // Parse the androidUrl to extract scheme and path
        const androidUrl = new URL(link.androidUrl);
        deepLinkUrl = `intent://${androidUrl.host}${androidUrl.pathname}${androidUrl.search}${androidUrl.hash}#Intent;scheme=${androidUrl.protocol.replace(':', '')};package=${project.androidPackageName};end`;
      } else {
        deepLinkUrl = link.androidUrl;
      }
      fallbackUrl =
        link.androidFallbackUrl ||
        (project && project.androidPlayStoreUrl) ||
        link.longUrl;
    }

    const escapedOgTitle = this.escapeHtml(ogTitle);
    const escapedOgDescription = this.escapeHtml(ogDescription);
    const escapedOgImageUrl = this.escapeHtml(ogImageUrl);
    const escapedShortCode = this.escapeHtml(shortCode);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapedOgTitle}</title>
<meta property="og:title" content="${escapedOgTitle}">
<meta property="og:description" content="${escapedOgDescription}">
${ogImageUrl ? `<meta property="og:image" content="${escapedOgImageUrl}">` : ''}
<meta property="og:type" content="website">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; background: #f9fafb; color: #111827; }
.container { text-align: center; padding: 2rem; max-width: 400px; }
.spinner { width: 40px; height: 40px; border: 3px solid #e5e7eb; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.8s linear infinite; margin: 0 auto 1.5rem; }
@keyframes spin { to { transform: rotate(360deg); } }
h1 { font-size: 1.25rem; margin-bottom: 0.5rem; }
p { color: #6b7280; font-size: 0.875rem; margin-bottom: 1.5rem; }
a { color: #3b82f6; text-decoration: none; font-size: 0.875rem; }
a:hover { text-decoration: underline; }
</style>
</head>
<body>
<div class="container">
<div class="spinner"></div>
<h1>Opening app...</h1>
<p>You will be redirected automatically.</p>
<a id="fallback-link" href="${this.escapeHtml(fallbackUrl)}">Click here if nothing happens</a>
</div>
<script type="application/json" id="chumbaq-params">${deepLinkParamsJson}</script>
<script nonce="${scriptNonce}">
(function() {
  var deepLink = ${JSON.stringify(deepLinkUrl).replace(/</g, '\\u003c')};
  var fallback = ${JSON.stringify(fallbackUrl).replace(/</g, '\\u003c')};
  var shortCode = ${JSON.stringify(shortCode).replace(/</g, '\\u003c')};
  var paramsEl = document.getElementById('chumbaq-params');
  var params = {};
  try { params = JSON.parse(paramsEl.textContent || '{}'); } catch (e) {}

  // Set cookies for deferred deep linking
  var expires = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = 'chumbaq_ref=' + encodeURIComponent(shortCode) + ';path=/;expires=' + expires + ';SameSite=Lax';
  document.cookie = 'chumbaq_params=' + encodeURIComponent(JSON.stringify(params)) + ';path=/;expires=' + expires + ';SameSite=Lax';

  // Try to open the deep link
  window.location.href = deepLink;

  // Fallback after 1500ms
  setTimeout(function() {
    window.location.href = fallback;
  }, 1500);
})();
</script>
</body>
</html>`;
  }

  async getLinkPreview(
    shortCode: string,
  ): Promise<{
    title: string;
    ogTitle: string;
    ogDescription: string;
    ogImageUrl: string;
    longUrl: string;
    shortCode: string;
  }> {
    const link = await this.linkRepository.findOne({
      where: { shortCode },
    });

    if (!link) {
      throw new NotFoundException('Link not found');
    }

    // The preview carries the destination URL.
    if (await this.suspension.isSuspended(link.projectId)) {
      throw new NotFoundException('Link is no longer active');
    }

    return {
      title: link.title || '',
      ogTitle: link.ogTitle || '',
      ogDescription: link.ogDescription || '',
      ogImageUrl: link.ogImageUrl || '',
      longUrl: link.longUrl,
      shortCode: link.shortCode,
    };
  }

  async getAppleAppSiteAssociation(
    domain: string,
  ): Promise<Record<string, any>> {
    const project = await this.projectRepository.findOne({
      where: { domain },
    });

    if (!project || !project.iosBundleId || !project.iosTeamId) {
      return {
        applinks: { details: [] },
        webcredentials: { apps: [] },
      };
    }

    const appId = `${project.iosTeamId}.${project.iosBundleId}`;

    return {
      applinks: {
        details: [
          {
            appIDs: [appId],
            components: [
              { '/': '/*', comment: 'Match all short links' },
            ],
          },
        ],
      },
      webcredentials: {
        apps: [appId],
      },
    };
  }

  async getAssetLinks(domain: string): Promise<Record<string, any>[]> {
    const project = await this.projectRepository.findOne({
      where: { domain },
    });

    if (!project || !project.androidPackageName) {
      return [];
    }

    const fingerprints = project.androidSha256Fingerprints
      ? project.androidSha256Fingerprints
          .split(',')
          .map((fp) => fp.trim())
          .filter(Boolean)
      : [];

    return [
      {
        relation: [
          'delegate_permission/common.handle_all_urls',
        ],
        target: {
          namespace: 'android_app',
          package_name: project.androidPackageName,
          sha256_cert_fingerprints: fingerprints,
        },
      },
    ];
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#x27;');
  }
}
