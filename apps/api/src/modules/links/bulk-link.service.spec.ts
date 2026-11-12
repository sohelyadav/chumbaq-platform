import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException } from '@nestjs/common';
import { BulkLinkService } from './bulk-link.service';
import { LinksService } from './links.service';

describe('BulkLinkService', () => {
  let service: BulkLinkService;

  const linksService = {
    create: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BulkLinkService,
        { provide: LinksService, useValue: linksService },
      ],
    }).compile();

    service = module.get<BulkLinkService>(BulkLinkService);
  });

  // ---------------------------------------------------------------------------
  // parseCsv
  // ---------------------------------------------------------------------------
  describe('parseCsv', () => {
    it('parses a basic CSV with longUrl + title + tags', () => {
      const csv = [
        'longUrl,title,tags',
        'https://a.example,Alpha,spring;sale',
        'https://b.example,Beta,',
      ].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result).toHaveLength(2);
      expect(result[0].longUrl).toBe('https://a.example');
      expect(result[0].title).toBe('Alpha');
      expect(result[0].tags).toEqual(['spring', 'sale']);
      expect(result[1].longUrl).toBe('https://b.example');
      expect(result[1].title).toBe('Beta');
      expect(result[1].tags).toBeUndefined();
    });

    it('accepts the alternate long_url header', () => {
      const csv = ['long_url', 'https://x.example'].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].longUrl).toBe('https://x.example');
    });

    it('accepts the alternate url header', () => {
      const csv = ['url', 'https://y.example'].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].longUrl).toBe('https://y.example');
    });

    it('maps snake_case platform columns to camelCase fields', () => {
      const csv = [
        'longUrl,ios_url,android_url,og_title,og_description',
        'https://a.example,ios://deep,android://deep,OG Title,OG Description',
      ].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].iosUrl).toBe('ios://deep');
      expect(result[0].androidUrl).toBe('android://deep');
      expect(result[0].ogTitle).toBe('OG Title');
      expect(result[0].ogDescription).toBe('OG Description');
    });

    it('leaves longUrl empty when no recognizable column is present', () => {
      const csv = ['other', 'foo'].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].longUrl).toBe('');
    });

    it('returns an empty array for a header-only CSV', () => {
      const csv = 'longUrl,title\n';

      const result = service.parseCsv(Buffer.from(csv));

      expect(result).toEqual([]);
    });

    it('filters out empty tag segments after splitting on ";"', () => {
      const csv = ['longUrl,tags', 'https://a.example,spring;;sale;'].join('\n');

      const result = service.parseCsv(Buffer.from(csv));

      expect(result[0].tags).toEqual(['spring', 'sale']);
    });

    it('throws BadRequestException for invalid CSV', () => {
      // csv-parse throws on unbalanced quotes when trim/columns are enabled
      const badCsv = 'longUrl\n"unterminated';

      expect(() => service.parseCsv(Buffer.from(badCsv))).toThrow(
        BadRequestException,
      );
    });

    it('throws BadRequestException when row count exceeds MAX_BULK_ROWS (5000)', () => {
      const header = 'longUrl';
      const rows = Array.from(
        { length: 5001 },
        (_, i) => `https://row${i}.example`,
      );
      const csv = [header, ...rows].join('\n');

      expect(() => service.parseCsv(Buffer.from(csv))).toThrow(BadRequestException);
      expect(() => service.parseCsv(Buffer.from(csv))).toThrow(
        /exceeds maximum of 5000/,
      );
    });
  });

  // ---------------------------------------------------------------------------
  // bulkCreate
  // ---------------------------------------------------------------------------
  describe('bulkCreate', () => {
    it('creates all links successfully when every DTO is valid', async () => {
      linksService.create.mockResolvedValue({ id: 'l-1' });
      const dtos = [
        { longUrl: 'https://a.example' },
        { longUrl: 'https://b.example' },
      ] as any;

      const result = await service.bulkCreate('proj-1', dtos);

      expect(result.total).toBe(2);
      expect(result.created).toBe(2);
      expect(result.errors).toEqual([]);
      expect(linksService.create).toHaveBeenCalledTimes(2);
    });

    it('records a missing-longUrl error without calling linksService.create', async () => {
      const dtos = [{ longUrl: '' }, { longUrl: 'https://ok.example' }] as any;
      linksService.create.mockResolvedValue({ id: 'l-1' });

      const result = await service.bulkCreate('proj-1', dtos);

      expect(result.created).toBe(1);
      expect(result.errors).toEqual([{ row: 1, error: 'Missing longUrl' }]);
      expect(linksService.create).toHaveBeenCalledTimes(1);
    });

    it('captures errors thrown by linksService.create with their message', async () => {
      linksService.create
        .mockResolvedValueOnce({ id: 'l-1' })
        .mockRejectedValueOnce(new Error('Short code "admin" is reserved'));
      const dtos = [
        { longUrl: 'https://a.example' },
        { longUrl: 'https://b.example', shortCode: 'admin' },
      ] as any;

      const result = await service.bulkCreate('proj-1', dtos);

      expect(result.total).toBe(2);
      expect(result.created).toBe(1);
      expect(result.errors).toEqual([
        { row: 2, error: 'Short code "admin" is reserved' },
      ]);
    });

    it('falls back to "Unknown error" when thrown value has no message', async () => {
      linksService.create.mockRejectedValueOnce({});
      const dtos = [{ longUrl: 'https://a.example' }] as any;

      const result = await service.bulkCreate('proj-1', dtos);

      expect(result.errors).toEqual([{ row: 1, error: 'Unknown error' }]);
    });

    it('handles an empty dto list', async () => {
      const result = await service.bulkCreate('proj-1', []);

      expect(result).toEqual({ total: 0, created: 0, errors: [] });
      expect(linksService.create).not.toHaveBeenCalled();
    });
  });
});
