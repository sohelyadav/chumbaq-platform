import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

/** QR images are 64 to 1024 pixels wide. */
export const QR_MIN_SIZE = 64;
export const QR_MAX_SIZE = 1024;

@Injectable()
export class QrCodeService {
  async generateQrCode(url: string, format: 'png' | 'svg' = 'png', size: number = 300): Promise<string> {
    if (format === 'svg') {
      return QRCode.toString(url, { type: 'svg', width: size });
    }
    return QRCode.toDataURL(url, { width: size, margin: 2 });
  }
}
