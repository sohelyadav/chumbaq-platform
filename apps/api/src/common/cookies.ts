import type { Request, Response } from 'express';

/**
 * Every value sent under `name`, in header order. Nest has no cookie parser installed
 * here, so `req.cookies` is always undefined: a route reading it silently sees nothing.
 */
export function readCookies(req: Pick<Request, 'headers'>, name: string): string[] {
  const values: string[] = [];
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const separator = part.indexOf('=');
    if (separator > 0 && part.slice(0, separator).trim() === name) {
      const value = part.slice(separator + 1).trim();
      if (value) values.push(value);
    }
  }
  return values;
}

/** The first cookie of that name, as sent. Not for credentials: see `SessionCookie`. */
export function readCookie(req: Pick<Request, 'headers'>, name: string): string | undefined {
  return readCookies(req, name)[0];
}

/**
 * A refresh-token cookie the API sets and reads back.
 *
 * Any host under the same site (a stage host, the marketing site) can set a cookie
 * with `Domain=` the parent and a longer path, which browsers send before the host's
 * own cookie of the same name: read first-wins, a planted junk value signs the person
 * out, and a planted valid one signs them into the planter's account. So when the
 * cookie is Secure its name carries the `__Host-` prefix, which browsers accept only
 * from this host, Secure, on `Path=/` and with no Domain: nobody else can plant one,
 * and there is only ever one.
 *
 * When Secure the bare name is never read, only cleared: a bare cookie may have been
 * planted, so a browser holding one from before the prefix signs in again once.
 * Browsers refuse `__Host-` without Secure, so a deployment that turns Secure off
 * (local http) keeps the bare name on its old path, accepted only when it is sent
 * exactly once.
 */
export class SessionCookie {
  constructor(
    private readonly baseName: string,
    private readonly barePath: string,
    private readonly secure: boolean,
  ) {}

  get name(): string {
    return this.secure ? `__Host-${this.baseName}` : this.baseName;
  }

  private options(path: string) {
    return { httpOnly: true, secure: this.secure, sameSite: 'strict' as const, path };
  }

  set(res: Response, value: string, maxAge: number): void {
    res.cookie(this.name, value, { ...this.options(this.secure ? '/' : this.barePath), maxAge });
    if (this.secure) this.clearBare(res);
  }

  clear(res: Response): void {
    res.clearCookie(this.name, this.options(this.secure ? '/' : this.barePath));
    if (this.secure) this.clearBare(res);
  }

  read(req: Pick<Request, 'headers'>): string | undefined {
    const values = readCookies(req, this.name);
    return values.length === 1 ? values[0] : undefined;
  }

  private clearBare(res: Response): void {
    res.clearCookie(this.baseName, this.options(this.barePath));
  }
}
