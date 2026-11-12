import { ProjectSuspensionService } from '../projects/project-suspension.service';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { NotFoundException } from '@nestjs/common';
import { RedirectService } from './redirect.service';
import { LinkEntity } from '../links/entities/link.entity';
import { ProjectEntity } from '../projects/entities/project.entity';
import { PlatformDetectorService, DeviceInfo } from './platform-detector.service';
import { LinkVariantsService } from '../links/link-variants.service';

describe('RedirectService', () => {
  let service: RedirectService;
  let linkRepo: { findOne: jest.Mock };
  let projectRepo: { findOne: jest.Mock };
  let platformDetector: { detect: jest.Mock };
  let linkVariantsService: { selectVariant: jest.Mock };

  const iosDeviceInfo: DeviceInfo = {
    platform: 'ios',
    deviceType: 'mobile',
    os: 'iOS',
    osVersion: '16',
    browser: 'Safari',
    browserVersion: '16',
  };

  const androidDeviceInfo: DeviceInfo = {
    platform: 'android',
    deviceType: 'mobile',
    os: 'Android',
    osVersion: '13',
    browser: 'Chrome',
    browserVersion: '115',
  };

  const desktopDeviceInfo: DeviceInfo = {
    platform: 'windows',
    deviceType: 'desktop',
    os: 'Windows',
    osVersion: '10',
    browser: 'Chrome',
    browserVersion: '115',
  };

  const baseProject: Partial<ProjectEntity> = {
    id: 'proj-1',
    name: 'Demo',
    iosAppStoreUrl: 'https://apps.apple.com/app/id123',
    androidPlayStoreUrl: 'https://play.google.com/store/apps/details?id=com.demo',
    androidPackageName: 'com.demo',
    iosBundleId: 'com.demo.ios',
    iosTeamId: 'TEAM123',
    androidSha256Fingerprints: 'AA:BB:CC, DD:EE:FF',
  };

  const baseLink = (overrides: Partial<LinkEntity> = {}): LinkEntity =>
    ({
      id: 'link-1',
      shortCode: 'abc',
      longUrl: 'https://example.com',
      iosUrl: 'myapp://deep/path',
      androidUrl: 'myapp://deep/path',
      iosFallbackUrl: null,
      androidFallbackUrl: null,
      title: 'My Link',
      ogTitle: 'OG Title',
      ogDescription: 'OG Description',
      ogImageUrl: 'https://example.com/img.png',
      deepLinkParams: { x: 1 },
      isActive: true,
      expiresAt: null,
      project: baseProject as ProjectEntity,
      projectId: 'proj-1',
      ...overrides,
    } as unknown as LinkEntity);

  let suspendedProject: string | null;
  let suspension: { isSuspended: jest.Mock };

  beforeEach(async () => {
    linkRepo = { findOne: jest.fn() };
    projectRepo = { findOne: jest.fn() };
    platformDetector = { detect: jest.fn() };
    linkVariantsService = { selectVariant: jest.fn().mockResolvedValue(null) };
    suspendedProject = null;
    suspension = { isSuspended: jest.fn(async (id: string) => id === suspendedProject) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        RedirectService,
        {
          provide: getRepositoryToken(LinkEntity),
          useValue: linkRepo,
        },
        {
          provide: getRepositoryToken(ProjectEntity),
          useValue: projectRepo,
        },
        {
          provide: PlatformDetectorService,
          useValue: platformDetector,
        },
        {
          provide: LinkVariantsService,
          useValue: linkVariantsService,
        },
        { provide: ProjectSuspensionService, useValue: suspension },
      ],
    }).compile();

    service = module.get<RedirectService>(RedirectService);
  });

  // ---------------------------------------------------------------------------
  // handleRedirect
  // ---------------------------------------------------------------------------
  describe('handleRedirect', () => {
    it('throws NotFoundException when the link does not exist', async () => {
      linkRepo.findOne.mockResolvedValueOnce(null);

      await expect(
        service.handleRedirect('missing', 'ua', '1.2.3.4', ''),
      ).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException when the link is inactive', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink({ isActive: false }));

      await expect(
        service.handleRedirect('abc', 'ua', '1.2.3.4', ''),
      ).rejects.toThrow('Link is no longer active');
    });

    it('throws NotFoundException when the link is expired', async () => {
      const expired = baseLink({
        expiresAt: new Date(Date.now() - 60 * 1000) as any,
      });
      linkRepo.findOne.mockResolvedValueOnce(expired);

      await expect(
        service.handleRedirect('abc', 'ua', '1.2.3.4', ''),
      ).rejects.toThrow('Link has expired');
    });

    it('returns interstitial for iOS device with iosUrl configured', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink());
      platformDetector.detect.mockReturnValueOnce(iosDeviceInfo);

      const result = await service.handleRedirect('abc', 'ua', '1.2.3.4', '');

      expect(result.type).toBe('interstitial');
      expect(result.platform).toBe('ios');
      expect(result.html).toBeTruthy();
      expect(result.html).toContain('myapp://deep/path');
    });

    it('returns interstitial for Android device with androidUrl configured', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink());
      platformDetector.detect.mockReturnValueOnce(androidDeviceInfo);

      const result = await service.handleRedirect('abc', 'ua', '1.2.3.4', '');

      expect(result.type).toBe('interstitial');
      expect(result.platform).toBe('android');
      expect(result.html).toContain('intent://');
    });

    it('returns a 302 redirect for desktop clients', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink());
      platformDetector.detect.mockReturnValueOnce(desktopDeviceInfo);

      const result = await service.handleRedirect('abc', 'ua', '1.2.3.4', '');

      expect(result.type).toBe('redirect');
      expect(result.url).toBe('https://example.com');
    });

    it('returns redirect when iOS has no iosUrl configured', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink({ iosUrl: null as any }));
      platformDetector.detect.mockReturnValueOnce(iosDeviceInfo);

      const result = await service.handleRedirect('abc', 'ua', '1.2.3.4', '');

      expect(result.type).toBe('redirect');
      expect(result.url).toBe('https://example.com');
    });

    it('applies A/B variant URL overrides when a variant is selected', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink());
      platformDetector.detect.mockReturnValueOnce(desktopDeviceInfo);
      linkVariantsService.selectVariant.mockResolvedValueOnce({
        id: 'variant-1',
        longUrl: 'https://variant.example.com',
        iosUrl: null,
        androidUrl: null,
      });

      const result = await service.handleRedirect('abc', 'ua', '1.2.3.4', '');

      expect(result.variantId).toBe('variant-1');
      expect(result.url).toBe('https://variant.example.com');
    });
  });

  // ---------------------------------------------------------------------------
  // getInterstitialHtml
  // ---------------------------------------------------------------------------
  describe('getInterstitialHtml', () => {
    it('contains the iOS deep link URL for iOS platform', () => {
      const html = service.getInterstitialHtml(
        baseLink(),
        baseProject as ProjectEntity,
        'ios',
        iosDeviceInfo, 'test-nonce'
      );

      expect(html).toContain('myapp://deep/path');
      expect(html).toContain('<script nonce="test-nonce">');
      // The data block is not code, and takes no nonce.
      expect(html.match(/<script(?![^>]*application\/json)[^>]*>/g)).toEqual(['<script nonce="test-nonce">']);
      expect(html).toContain('chumbaq-params');
    });

    it('builds an intent:// URL when androidPackageName is present', () => {
      const link = baseLink({ androidUrl: 'myapp://deep/path?x=1' });
      const html = service.getInterstitialHtml(
        link,
        baseProject as ProjectEntity,
        'android',
        androidDeviceInfo, 'test-nonce'
      );

      expect(html).toContain('intent://');
      expect(html).toContain('package=com.demo');
      expect(html).toContain('scheme=myapp');
    });

    it('falls back to androidUrl directly when project has no androidPackageName', () => {
      const html = service.getInterstitialHtml(
        baseLink(),
        { ...baseProject, androidPackageName: null } as unknown as ProjectEntity,
        'android',
        androidDeviceInfo, 'test-nonce'
      );

      expect(html).toContain('myapp://deep/path');
      expect(html).not.toContain('intent://');
    });

    it('escapes HTML in ogTitle to prevent XSS', () => {
      const link = baseLink({ ogTitle: '<script>alert(1)</script>' });
      const html = service.getInterstitialHtml(
        link,
        baseProject as ProjectEntity,
        'ios',
        iosDeviceInfo, 'test-nonce'
      );

      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('&lt;script&gt;');
    });

    it('escapes < in deep link params JSON to prevent script breakout', () => {
      const link = baseLink({
        deepLinkParams: { payload: '</script><script>x</script>' },
      });

      const html = service.getInterstitialHtml(
        link,
        baseProject as ProjectEntity,
        'ios',
        iosDeviceInfo, 'test-nonce'
      );

      // JSON block should not contain raw </script>
      expect(html).not.toMatch(/<\/script><script>x<\/script>/);
      expect(html).toContain('\\u003c');
    });

    it('uses iosFallbackUrl when set, otherwise app store url, otherwise longUrl', () => {
      const link = baseLink({ iosFallbackUrl: 'https://fallback.example.com' });
      const html = service.getInterstitialHtml(
        link,
        baseProject as ProjectEntity,
        'ios',
        iosDeviceInfo, 'test-nonce'
      );

      expect(html).toContain('https://fallback.example.com');
    });

    it('uses iosAppStoreUrl as fallback when iosFallbackUrl is not set', () => {
      const html = service.getInterstitialHtml(
        baseLink(),
        baseProject as ProjectEntity,
        'ios',
        iosDeviceInfo, 'test-nonce'
      );

      expect(html).toContain('https://apps.apple.com/app/id123');
    });
  });

  // ---------------------------------------------------------------------------
  // getLinkPreview
  // ---------------------------------------------------------------------------
  describe('getLinkPreview', () => {
    it('returns preview metadata for a found link', async () => {
      linkRepo.findOne.mockResolvedValueOnce(baseLink());

      const preview = await service.getLinkPreview('abc');

      expect(preview).toEqual({
        title: 'My Link',
        ogTitle: 'OG Title',
        ogDescription: 'OG Description',
        ogImageUrl: 'https://example.com/img.png',
        longUrl: 'https://example.com',
        shortCode: 'abc',
      });
    });

    it('throws NotFoundException when link does not exist', async () => {
      linkRepo.findOne.mockResolvedValueOnce(null);

      await expect(service.getLinkPreview('missing')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // getAppleAppSiteAssociation
  // ---------------------------------------------------------------------------
  describe('getAppleAppSiteAssociation', () => {
    it('returns empty applinks when project is not found', async () => {
      projectRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getAppleAppSiteAssociation('missing.com');

      expect(result).toEqual({
        applinks: { details: [] },
        webcredentials: { apps: [] },
      });
    });

    it('returns a populated AASA when project has iosBundleId and iosTeamId', async () => {
      projectRepo.findOne.mockResolvedValueOnce(baseProject);

      const result = await service.getAppleAppSiteAssociation('example.com');

      expect(result.applinks.details).toHaveLength(1);
      expect(result.applinks.details[0].appIDs).toEqual(['TEAM123.com.demo.ios']);
      expect(result.webcredentials.apps).toEqual(['TEAM123.com.demo.ios']);
    });

    it('returns empty applinks when iosBundleId is missing', async () => {
      projectRepo.findOne.mockResolvedValueOnce({
        ...baseProject,
        iosBundleId: null,
      });

      const result = await service.getAppleAppSiteAssociation('example.com');
      expect(result.applinks.details).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // getAssetLinks
  // ---------------------------------------------------------------------------
  describe('getAssetLinks', () => {
    it('returns an empty array when project is not found', async () => {
      projectRepo.findOne.mockResolvedValueOnce(null);

      const result = await service.getAssetLinks('missing.com');

      expect(result).toEqual([]);
    });

    it('returns an empty array when androidPackageName is missing', async () => {
      projectRepo.findOne.mockResolvedValueOnce({
        ...baseProject,
        androidPackageName: null,
      });

      const result = await service.getAssetLinks('example.com');
      expect(result).toEqual([]);
    });

    it('parses comma-separated fingerprints into an array', async () => {
      projectRepo.findOne.mockResolvedValueOnce(baseProject);

      const result = await service.getAssetLinks('example.com');

      expect(result).toHaveLength(1);
      expect(result[0].target.package_name).toBe('com.demo');
      expect(result[0].target.sha256_cert_fingerprints).toEqual([
        'AA:BB:CC',
        'DD:EE:FF',
      ]);
    });

    it('returns empty fingerprints array when the fingerprints field is empty', async () => {
      projectRepo.findOne.mockResolvedValueOnce({
        ...baseProject,
        androidSha256Fingerprints: null,
      });

      const result = await service.getAssetLinks('example.com');

      expect(result[0].target.sha256_cert_fingerprints).toEqual([]);
    });
  });

  describe('suspended tenant', () => {
    beforeEach(() => {
      platformDetector.detect.mockReturnValue({ platform: 'ios', deviceType: 'mobile' });
    });

    it('answers a redirect exactly as it answers an inactive link', async () => {
      suspendedProject = 'proj-1';
      linkRepo.findOne.mockResolvedValueOnce(baseLink());
      const suspended = await service
        .handleRedirect('abc123', 'ua', '1.1.1.1', '')
        .catch((error) => error);

      linkRepo.findOne.mockResolvedValueOnce(baseLink({ isActive: false, projectId: 'other' }));
      const inactive = await service
        .handleRedirect('abc123', 'ua', '1.1.1.1', '')
        .catch((error) => error);

      expect(suspended).toBeInstanceOf(NotFoundException);
      expect(suspended.getResponse()).toEqual(inactive.getResponse());
    });

    it('does not pick a variant for a suspended link', async () => {
      suspendedProject = 'proj-1';
      linkRepo.findOne.mockResolvedValueOnce(baseLink());

      await expect(service.handleRedirect('abc123', 'ua', '1.1.1.1', '')).rejects.toThrow(
        NotFoundException,
      );
      expect(linkVariantsService.selectVariant).not.toHaveBeenCalled();
    });

    it('refuses the preview, which would otherwise hand out the destination', async () => {
      suspendedProject = 'proj-1';
      linkRepo.findOne.mockResolvedValueOnce(baseLink());

      const error = await service.getLinkPreview('abc123').catch((caught) => caught);

      expect(error).toBeInstanceOf(NotFoundException);
      expect(JSON.stringify(error.getResponse())).not.toContain('example.com');
    });

    it('leaves another tenant\'s links working on both routes', async () => {
      suspendedProject = 'someone-else';
      linkRepo.findOne.mockResolvedValueOnce(baseLink()).mockResolvedValueOnce(baseLink());

      const result = await service.handleRedirect('abc123', 'ua', '1.1.1.1', '');
      const preview = await service.getLinkPreview('abc123');

      expect(result.type).toBe('interstitial');
      expect(preview.longUrl).toBe('https://example.com');
    });
  });
});
