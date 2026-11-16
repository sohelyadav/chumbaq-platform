import { AddressAudience, AddressAudienceScope } from '../modules/push-notifications/services/address-audience';
import { AudienceScope, PushTokensService } from '../modules/push-tokens/push-tokens.service';

/**
 * Whole audiences, read the way the scheduler reads them (a page at a time), for
 * tests that check who is in one. A small page size, so paging itself is exercised.
 */
const PAGE = 2;

type Row = { id: string; timezone: string };

async function all(next: (after: string | null) => Promise<Row[]>): Promise<Row[]> {
  const rows: Row[] = [];
  let after: string | null = null;
  for (;;) {
    const page = await next(after);
    rows.push(...page);
    if (page.length < PAGE) return rows;
    after = page[page.length - 1].id;
  }
}

function grouped(rows: Row[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of rows) out.set(row.timezone, [...(out.get(row.timezone) ?? []), row.id]);
  return out;
}

export async function allRecipientIds(audience: AddressAudience, scope: AddressAudienceScope): Promise<string[]> {
  return (await all((after) => audience.pageIds(scope, after, PAGE, 'UTC'))).map((row) => row.id);
}

export async function recipientsByTimezone(
  audience: AddressAudience,
  scope: AddressAudienceScope,
  fallback: string,
): Promise<Map<string, string[]>> {
  return grouped(await all((after) => audience.pageIds(scope, after, PAGE, fallback)));
}

export async function allPushAudienceIds(tokens: PushTokensService, scope: AudienceScope): Promise<string[]> {
  return (await all((after) => tokens.pageAudience(scope, after, PAGE, 'UTC'))).map((row) => row.id);
}

export async function pushAudienceByTimezone(
  tokens: PushTokensService,
  scope: AudienceScope,
  fallback: string,
): Promise<Map<string, string[]>> {
  return grouped(await all((after) => tokens.pageAudience(scope, after, PAGE, fallback)));
}
