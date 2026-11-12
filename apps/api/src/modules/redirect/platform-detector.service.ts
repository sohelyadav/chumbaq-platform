import { Injectable } from '@nestjs/common';
import UAParser = require('ua-parser-js');

export interface DeviceInfo {
  platform: 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other';
  deviceType: 'mobile' | 'tablet' | 'desktop';
  os: string;
  osVersion: string;
  browser: string;
  browserVersion: string;
}

@Injectable()
export class PlatformDetectorService {
  detect(userAgent: string): DeviceInfo {
    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    const os = result.os.name || '';
    const osVersion = result.os.version || '';
    const browser = result.browser.name || '';
    const browserVersion = result.browser.version || '';
    const deviceType = this.mapDeviceType(result.device.type);
    const platform = this.mapPlatform(os);

    return {
      platform,
      deviceType,
      os,
      osVersion,
      browser,
      browserVersion,
    };
  }

  private mapPlatform(
    os: string,
  ): 'ios' | 'android' | 'windows' | 'macos' | 'linux' | 'other' {
    const lower = os.toLowerCase();
    if (lower === 'ios' || lower === 'mac os') {
      // Distinguish between macOS desktop and iOS
      // ua-parser-js reports 'iOS' for iPhone/iPad and 'Mac OS' for desktop Mac
      if (lower === 'ios') return 'ios';
      return 'macos';
    }
    if (lower === 'android') return 'android';
    if (lower.includes('windows')) return 'windows';
    if (lower.includes('linux') || lower.includes('ubuntu') || lower.includes('fedora') || lower.includes('debian')) {
      return 'linux';
    }
    return 'other';
  }

  private mapDeviceType(type: string | undefined): 'mobile' | 'tablet' | 'desktop' {
    if (type === 'mobile') return 'mobile';
    if (type === 'tablet') return 'tablet';
    return 'desktop';
  }
}
