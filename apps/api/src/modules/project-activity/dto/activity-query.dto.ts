import { BadRequestException, PipeTransform } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, validateSync } from 'class-validator';
import { isUuid } from '../../project-access/project-access.service';
import { ACTIVITY_GROUPS, type ActivityGroup } from '../activity-groups';

/** Every refused filter gets this one answer, whatever was wrong. */
export const INVALID_ACTIVITY_FILTER = 'Invalid activity filter.';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** What a cursor holds: the row's time to the microsecond, as Postgres keeps it, and its id. */
const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)\|([0-9a-f-]{36})$/;

/** The filters the page and the download share. */
export class ActivityFilterDto {
  @IsOptional()
  @IsString()
  @Matches(UUID_SHAPE)
  actor?: string;

  @IsOptional()
  @IsString()
  @IsIn(ACTIVITY_GROUPS)
  group?: ActivityGroup;

  /** A UTC day, `YYYY-MM-DD`, from its first instant. */
  @IsOptional()
  @IsString()
  @Matches(DAY)
  from?: string;

  /** A UTC day, `YYYY-MM-DD`, to its last instant. */
  @IsOptional()
  @IsString()
  @Matches(DAY)
  to?: string;
}

/** The page's query: the filters and where the previous page ended. */
export class ActivityQueryDto extends ActivityFilterDto {
  /** Opaque to the client: base64url of `occurredAt|id`. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  cursor?: string;
}

/** Where a page starts: strictly older than this row. */
export interface ActivityCursor {
  occurredAt: string;
  id: string;
}

/** The parsed filters. `from` and `to` are the bounds as instants: `occurred_at >= from AND < before`. */
export interface ActivityFilters {
  actor?: string;
  group?: ActivityGroup;
  from?: Date;
  /** The instant after the `to` day, so the whole day, to the microsecond, is in. */
  before?: Date;
  /** The filters as the caller wrote them, for the export's log entry. */
  raw: { actor?: string; group?: ActivityGroup; from?: string; to?: string };
}

export interface ActivityQuery extends ActivityFilters {
  cursor?: ActivityCursor;
}

/** No entry is older than this; earlier years in a cursor are refused. */
const MIN_CURSOR_YEAR = 1970;

const invalid = () => new BadRequestException(INVALID_ACTIVITY_FILTER);

/** The start of a real UTC day (`2026-02-30` is not one), or null. */
function startOfDay(value: string): Date | null {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null;
}

export function encodeActivityCursor(cursor: ActivityCursor): string {
  return Buffer.from(`${cursor.occurredAt}|${cursor.id}`, 'utf8').toString('base64url');
}

/** Only `(occurredAt, id)`: nothing in a cursor can name a project. */
function decodeCursor(value: string): ActivityCursor {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw invalid();
  const match = CURSOR.exec(Buffer.from(value, 'base64url').toString('utf8'));
  if (!match || !isUuid(match[2])) throw invalid();
  const [, occurredAt, id] = match;
  // A real instant: month 13 would reach Postgres and come back a 500.
  const ms = new Date(`${occurredAt.slice(0, 23)}Z`);
  if (Number.isNaN(ms.getTime()) || ms.toISOString().slice(0, 23) !== occurredAt.slice(0, 23)) throw invalid();
  // Nothing is logged before 1970, and Postgres refuses year 0000 (a 500 otherwise).
  if (Number(occurredAt.slice(0, 4)) < MIN_CURSOR_YEAR) throw invalid();
  return { occurredAt, id: id.toLowerCase() };
}

/**
 * Validates the activity query with `dto` and parses it, answering every problem with
 * 400 `Invalid activity filter.`. The handler's parameter is typed with an interface, so
 * the global ValidationPipe (which has its own messages) passes it through untouched and
 * this pipe is the only check. Unknown keys and repeated keys are refused.
 */
export class ActivityQueryPipe implements PipeTransform<unknown, ActivityQuery> {
  constructor(private readonly dto: typeof ActivityFilterDto | typeof ActivityQueryDto) {}

  transform(value: unknown): ActivityQuery {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid();
    const instance = plainToInstance(this.dto, value) as ActivityQueryDto;
    const errors = validateSync(instance, { whitelist: true, forbidNonWhitelisted: true });
    if (errors.length > 0) throw invalid();

    const from = instance.from !== undefined ? startOfDay(instance.from) : undefined;
    const toDay = instance.to !== undefined ? startOfDay(instance.to) : undefined;
    if (from === null || toDay === null) throw invalid();
    if (from && toDay && from.getTime() > toDay.getTime()) throw invalid();
    const before = toDay ? new Date(toDay.getTime() + 24 * 60 * 60 * 1000) : undefined;

    const raw: ActivityFilters['raw'] = {};
    if (instance.actor !== undefined) raw.actor = instance.actor.toLowerCase();
    if (instance.group !== undefined) raw.group = instance.group;
    if (instance.from !== undefined) raw.from = instance.from;
    if (instance.to !== undefined) raw.to = instance.to;

    return {
      actor: raw.actor,
      group: instance.group,
      from,
      before,
      raw,
      cursor: instance.cursor !== undefined ? decodeCursor(instance.cursor) : undefined,
    };
  }
}
