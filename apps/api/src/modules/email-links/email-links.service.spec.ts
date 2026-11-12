import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailLinksService } from './email-links.service';
import { BadRequestException } from '@nestjs/common';
import { LinksService } from '../links/links.service';

describe('EmailLinksService', () => {
  let service: EmailLinksService;

  const linksService = {
    create: jest.fn(),
  };

  const configService = {
    getOrThrow: jest.fn(),
  };

  beforeEach(async () => {
    jest.clearAllMocks();
    configService.getOrThrow.mockReturnValue('https://dy.link');

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        EmailLinksService,
        { provide: LinksService, useValue: linksService },
        { provide: ConfigService, useValue: configService },
      ],
    }).compile();

    service = module.get<EmailLinksService>(EmailLinksService);
  });

  describe('rewriteHtml', () => {
    it('refuses a missing html body with a 400, not a crash', async () => {
      await expect(
        service.rewriteHtml('proj-1', undefined as unknown as string),
      ).rejects.toThrow(BadRequestException);
    });

    it('rewrites an http(s) href to a short link URL', async () => {
      linksService.create.mockResolvedValue({ shortCode: 'abc1234' });
      const html = '<a href="https://example.com/page">Click</a>';

      const result = await service.rewriteHtml('proj-1', html);

      expect(configService.getOrThrow).toHaveBeenCalledWith('app.appUrl');
      expect(linksService.create).toHaveBeenCalledWith('proj-1', {
        longUrl: 'https://example.com/page',
        title: expect.stringContaining('Email link: https://example.com/page'),
      });
      expect(result).toBe('<a href="https://dy.link/abc1234">Click</a>');
    });

    it('rewrites multiple links in a single document', async () => {
      linksService.create
        .mockResolvedValueOnce({ shortCode: 'one' })
        .mockResolvedValueOnce({ shortCode: 'two' });
      const html =
        '<p><a href="https://a.example">A</a><a href="https://b.example">B</a></p>';

      const result = await service.rewriteHtml('proj-1', html);

      expect(result).toContain('href="https://dy.link/one"');
      expect(result).toContain('href="https://dy.link/two"');
      expect(result).not.toContain('href="https://a.example"');
      expect(result).not.toContain('href="https://b.example"');
    });

    it('skips a link that fails to create and keeps the original href intact', async () => {
      linksService.create
        .mockRejectedValueOnce(new Error('bad url'))
        .mockResolvedValueOnce({ shortCode: 'ok' });
      const html =
        '<a href="https://fail.example">F</a><a href="https://ok.example">O</a>';

      const result = await service.rewriteHtml('proj-1', html);

      expect(result).toContain('href="https://fail.example"'); // preserved
      expect(result).toContain('href="https://dy.link/ok"');
    });

    it('leaves HTML without any href unchanged', async () => {
      const html = '<p>No links here!</p>';

      const result = await service.rewriteHtml('proj-1', html);

      expect(result).toBe(html);
      expect(linksService.create).not.toHaveBeenCalled();
    });

    it('leaves mailto and non-http hrefs untouched', async () => {
      const html =
        '<a href="mailto:test@example.com">mail</a><a href="/relative">rel</a>';

      const result = await service.rewriteHtml('proj-1', html);

      expect(result).toBe(html);
      expect(linksService.create).not.toHaveBeenCalled();
    });

    it('truncates the title prefix to the first 50 chars of the long URL', async () => {
      linksService.create.mockResolvedValue({ shortCode: 'abc' });
      const longUrl = 'https://example.com/' + 'x'.repeat(200);
      const html = `<a href="${longUrl}">click</a>`;

      await service.rewriteHtml('proj-1', html);

      const dto = linksService.create.mock.calls[0][1];
      expect(dto.title).toBe(`Email link: ${longUrl.substring(0, 50)}`);
      // The title portion after the prefix must be exactly 50 chars
      expect(dto.title.replace('Email link: ', '').length).toBe(50);
    });

    it('handles single-quoted href attributes', async () => {
      linksService.create.mockResolvedValue({ shortCode: 'sq' });
      const html = "<a href='https://single.example'>click</a>";

      const result = await service.rewriteHtml('proj-1', html);

      expect(linksService.create).toHaveBeenCalled();
      expect(result).toContain('href="https://dy.link/sq"');
    });
  });
});
