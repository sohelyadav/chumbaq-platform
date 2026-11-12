import type { Request } from 'express';

/**
 * One cookie from the header, as sent. Nest has no cookie parser installed here, so
 * `req.cookies` is always undefined: a route reading it silently sees nothing.
 */
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      return part.slice(separator + 1).trim() || undefined;
    }
  }
  return undefined;
}
