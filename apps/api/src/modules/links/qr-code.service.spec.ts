import { Test, TestingModule } from '@nestjs/testing';
import { QrCodeService } from './qr-code.service';
import * as QRCode from 'qrcode';

jest.mock('qrcode', () => ({
  toString: jest.fn(),
  toDataURL: jest.fn(),
}));

describe('QrCodeService', () => {
  let service: QrCodeService;
  const mockedToString = QRCode.toString as unknown as jest.Mock;
  const mockedToDataUrl = QRCode.toDataURL as unknown as jest.Mock;

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [QrCodeService],
    }).compile();

    service = module.get<QrCodeService>(QrCodeService);
  });

  describe('generateQrCode', () => {
    it('defaults to PNG data URL with size 300', async () => {
      mockedToDataUrl.mockResolvedValue('data:image/png;base64,AAA');

      const result = await service.generateQrCode('https://example.com');

      expect(mockedToDataUrl).toHaveBeenCalledWith('https://example.com', {
        width: 300,
        margin: 2,
      });
      expect(result).toBe('data:image/png;base64,AAA');
      expect(mockedToString).not.toHaveBeenCalled();
    });

    it('returns SVG markup when format is "svg"', async () => {
      mockedToString.mockResolvedValue('<svg>...</svg>');

      const result = await service.generateQrCode(
        'https://example.com',
        'svg',
        512,
      );

      expect(mockedToString).toHaveBeenCalledWith('https://example.com', {
        type: 'svg',
        width: 512,
      });
      expect(result).toBe('<svg>...</svg>');
      expect(mockedToDataUrl).not.toHaveBeenCalled();
    });

    it('honours the custom size for PNG', async () => {
      mockedToDataUrl.mockResolvedValue('data:image/png;base64,ZZZ');

      await service.generateQrCode('https://example.com', 'png', 800);

      expect(mockedToDataUrl).toHaveBeenCalledWith('https://example.com', {
        width: 800,
        margin: 2,
      });
    });

    it('propagates errors thrown by the qrcode library', async () => {
      mockedToDataUrl.mockRejectedValue(new Error('encoding failed'));

      await expect(service.generateQrCode('https://x')).rejects.toThrow(
        'encoding failed',
      );
    });
  });
});
