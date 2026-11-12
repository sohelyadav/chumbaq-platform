import type { Request } from 'express';
import { getClientIp } from '../../common/client-ip';

/** Where a logged action came from. Staff entries pass nulls. */
export interface ActivityContext {
  ipAddress: string | null;
  userAgent: string | null;
}

const USER_AGENT_LIMIT = 512;

/** The request's address (by the project's one rule, `getClientIp`) and user agent. */
export function activityContext(req: Request): ActivityContext {
  const userAgent = req.headers['user-agent'];
  return {
    ipAddress: getClientIp(req) || null,
    userAgent: typeof userAgent === 'string' ? userAgent.slice(0, USER_AGENT_LIMIT) : null,
  };
}
