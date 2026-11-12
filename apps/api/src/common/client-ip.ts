import type { Request } from 'express';

/**
 * How much of `X-Forwarded-For` the application is willing to believe.
 *
 * `scripts/deploy-setup.sh` is the deployment: one Nginx on the same host,
 * proxying to `127.0.0.1:3000` and setting
 * `X-Forwarded-For $proxy_add_x_forwarded_for`, which **appends** the socket
 * address it observed to whatever the client already sent. So the header is
 * `<anything the client invented>, <the address Nginx saw>` and only the
 * rightmost entry is ours.
 *
 * `'loopback'` makes Express walk the list from the right, skipping entries
 * contributed by loopback peers, and stop at the first address no trusted hop
 * vouched for. Behind the Nginx above that is the real client. With the API
 * exposed directly — no proxy — the peer is not loopback, so the header is
 * ignored entirely and the socket address wins. Both are the answer we want,
 * which is why this is a class of trusted address rather than a hop count:
 * `'loopback'` degrades safely if someone drops the proxy, where `1` would
 * start handing an attacker a header they fully control.
 *
 * Two trusted hops (a CDN in front of the Nginx) would need this widened to
 * include the CDN's ranges — until then the CDN's own egress address is what
 * attribution would record.
 */
export const TRUST_PROXY = 'loopback';

/**
 * The client's IP address, as derived from the request alone.
 *
 * **Never take this from a request body.** Deferred attribution joins an
 * install to a click on this value, so a caller who can name an IP can claim a
 * click that belongs to someone else — read the link's `deepLinkParams`, flip
 * the click to `matched`, and deny the real installer their attribution. The
 * only thing stopping that is that there is nowhere to put an IP but here.
 *
 * Both sides of the join must derive it identically or the addresses stop
 * comparing equal and matching quietly degrades to never matching, which is
 * indistinguishable from a device that genuinely never clicked. That is the
 * reason this is one function: the click recorder and the matcher call it, and
 * so should anything else that stores or compares a client address.
 *
 * Requires {@link TRUST_PROXY} to be set on the Express instance (see
 * `main.ts`); `req.ip` is otherwise the raw socket address, which behind the
 * deployment's Nginx is always `127.0.0.1`.
 */
export function getClientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || '';
}
