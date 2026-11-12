import { Injectable } from '@nestjs/common';
import * as QRCode from 'qrcode';

@Injectable()
export class QrCodeService {
  async generateQrCode(url: string, format: 'png' | 'svg' = 'png', size: number = 300): Promise<string> {
    if (format === 'svg') {
      return QRCode.toString(url, { type: 'svg', width: size });
    }
    return QRCode.toDataURL(url, { width: size, margin: 2 });
  }
}
