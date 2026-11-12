import { Injectable, BadRequestException } from '@nestjs/common';
import { parse } from 'csv-parse/sync';
import { LinksService } from './links.service';
import { CreateLinkDto } from './dto/create-link.dto';

export interface BulkCreateResult {
  total: number;
  created: number;
  errors: { row: number; error: string }[];
}

const MAX_BULK_ROWS = 5000;

@Injectable()
export class BulkLinkService {
  constructor(
    private readonly linksService: LinksService,
  ) {}

  parseCsv(buffer: Buffer): CreateLinkDto[] {
    try {
      const records = parse(buffer, {
        columns: true,
        skip_empty_lines: true,
        trim: true,
      });
      if ((records as unknown[]).length > MAX_BULK_ROWS) {
        throw new BadRequestException(
          `CSV exceeds maximum of ${MAX_BULK_ROWS} rows`,
        );
      }
      return (records as Record<string, string>[]).map((record) => {
        const dto = new CreateLinkDto();
        dto.longUrl = record.longUrl || record.long_url || record.url || '';
        dto.title = record.title || undefined;
        dto.tags = record.tags ? record.tags.split(';').map((t: string) => t.trim()).filter(Boolean) : undefined;
        dto.iosUrl = record.iosUrl || record.ios_url || undefined;
        dto.androidUrl = record.androidUrl || record.android_url || undefined;
        dto.ogTitle = record.ogTitle || record.og_title || undefined;
        dto.ogDescription = record.ogDescription || record.og_description || undefined;
        return dto;
      });
    } catch (err) {
      if (err instanceof BadRequestException) throw err;
      throw new BadRequestException('Invalid CSV format');
    }
  }

  async bulkCreate(
    projectId: string,
    dtos: CreateLinkDto[],
  ): Promise<BulkCreateResult> {
    const result: BulkCreateResult = { total: dtos.length, created: 0, errors: [] };

    for (let i = 0; i < dtos.length; i++) {
      try {
        if (!dtos[i].longUrl) {
          result.errors.push({ row: i + 1, error: 'Missing longUrl' });
          continue;
        }
        await this.linksService.create(projectId, dtos[i]);
        result.created++;
      } catch (err: any) {
        result.errors.push({ row: i + 1, error: err.message || 'Unknown error' });
      }
    }

    return result;
  }
}
