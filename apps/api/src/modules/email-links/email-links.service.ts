import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LinksService } from '../links/links.service';

@Injectable()
export class EmailLinksService {
  constructor(
    private readonly linksService: LinksService,
    private readonly configService: ConfigService,
  ) {}

  async rewriteHtml(projectId: string, html: string): Promise<string> {
    // Access is checked by the route's permission guard before this runs.
    if (typeof html !== 'string') throw new BadRequestException('html must be a string');
    const appUrl = this.configService.getOrThrow<string>('app.appUrl');
    const hrefRegex = /href=["'](https?:\/\/[^"']+)["']/gi;
    const links: { original: string; replacement: string }[] = [];

    const matches = [...html.matchAll(hrefRegex)];

    for (const match of matches) {
      const originalUrl = match[1];
      try {
        const link = await this.linksService.create(projectId, {
          longUrl: originalUrl,
          title: `Email link: ${originalUrl.substring(0, 50)}`,
        });
        const shortUrl = `${appUrl}/${link.shortCode}`;
        links.push({ original: match[0], replacement: `href="${shortUrl}"` });
      } catch {
        // Skip links that can't be created
      }
    }

    let result = html;
    for (const { original, replacement } of links) {
      result = result.replace(original, replacement);
    }

    return result;
  }
}
