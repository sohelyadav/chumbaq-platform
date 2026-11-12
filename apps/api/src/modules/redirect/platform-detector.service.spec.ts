import { Test, TestingModule } from '@nestjs/testing';
import { PlatformDetectorService } from './platform-detector.service';

describe('PlatformDetectorService', () => {
  let service: PlatformDetectorService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [PlatformDetectorService],
    }).compile();

    service = module.get<PlatformDetectorService>(PlatformDetectorService);
  });

  describe('detect', () => {
    it('returns ios platform for an iPhone user agent', () => {
      const ua =
        'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';

      const result = service.detect(ua);

      expect(result.platform).toBe('ios');
      expect(result.deviceType).toBe('mobile');
    });

    it('returns ios platform for an iPad user agent', () => {
      const ua =
        'Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';

      const result = service.detect(ua);

      expect(result.platform).toBe('ios');
    });

    it('returns android platform for an Android user agent', () => {
      const ua =
        'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Mobile Safari/537.36';

      const result = service.detect(ua);

      expect(result.platform).toBe('android');
      expect(result.deviceType).toBe('mobile');
    });

    it('returns windows platform for a Windows desktop user agent', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

      const result = service.detect(ua);

      expect(result.platform).toBe('windows');
      expect(result.deviceType).toBe('desktop');
    });

    it('returns macos platform for a Mac desktop user agent', () => {
      const ua =
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15';

      const result = service.detect(ua);

      expect(result.platform).toBe('macos');
      expect(result.deviceType).toBe('desktop');
    });

    it('returns other platform for an empty or unknown user agent', () => {
      const result = service.detect('');
      expect(result.platform).toBe('other');
    });

    it('populates browser and os fields for a known user agent', () => {
      const ua =
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36';

      const result = service.detect(ua);

      expect(result.browser).toBeTruthy();
      expect(result.os).toBeTruthy();
    });
  });
});
