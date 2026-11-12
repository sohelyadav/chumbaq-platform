import { randomUUID } from 'crypto';
import type { NextFunction, Request, Response } from 'express';

/** nginx's `$request_id` is 32 hex characters; anything else is replaced. */
const VALID = /^[A-Za-z0-9-]{1,64}$/;

/**
 * Ties a request's lines together across logs: nginx sets `X-Request-Id` and logs it,
 * this keeps it (or makes one, where nothing in front sets it), returns it as a response
 * header, and the error filter puts it in every error line. A header that could forge a
 * log line (spaces, newlines, overlong) is replaced, never logged.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  const presented = req.headers['x-request-id'];
  const id = typeof presented === 'string' && VALID.test(presented) ? presented : randomUUID();
  (req as Request & { requestId?: string }).requestId = id;
  res.setHeader('X-Request-Id', id);
  next();
}

export function requestIdOf(req: Request): string | undefined {
  return (req as Request & { requestId?: string }).requestId;
}
