import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type { LookupFunction } from 'net';
import { isPrivateAddress, VettedWebhookTarget } from './webhook-address';

/** Which addresses a socket may reach. Only tests pass anything but `isPublic`. */
export type AddressPolicy = (address: string) => boolean;
const isPublic: AddressPolicy = (address) => !isPrivateAddress(address);

/**
 * A lookup that answers only with the addresses already checked, and never
 * asks DNS. fetch() would resolve the name again at connect time, and a
 * TTL-0 attacker domain can answer public to the check and 127.0.0.1 to the
 * connection; with this the second answer is never sought.
 *
 * It re-checks what it hands out as well, so a caller that passes unvetted
 * addresses still cannot reach a private one.
 */
export function pinnedLookup(
  addresses: VettedWebhookTarget['addresses'],
  mayConnectTo: AddressPolicy = isPublic,
): LookupFunction {
  return (_hostname, options, callback) => {
    const usable = addresses.filter(({ address }) => mayConnectTo(address));
    const family = typeof options === 'object' ? options.family : options;
    const wanted =
      family === 4 || family === 6 || family === 'IPv4' || family === 'IPv6'
        ? usable.filter((a) => a.family === (family === 'IPv4' ? 4 : family === 'IPv6' ? 6 : family))
        : usable;
    if (wanted.length === 0) {
      const err = Object.assign(new Error('No vetted address for webhook host'), { code: 'ENOTFOUND' });
      return callback(err, typeof options === 'object' && options.all ? [] : '', 4);
    }
    // Node's happy-eyeballs connect asks for all; plain connect asks for one.
    if (typeof options === 'object' && options.all) {
      (callback as unknown as (e: null, a: typeof wanted) => void)(null, wanted);
    } else {
      callback(null, wanted[0].address, wanted[0].family);
    }
  };
}

export interface WebhookRequest {
  headers: Record<string, string>;
  body: string;
  timeoutMs: number;
}

/**
 * POSTs to a vetted target over a socket that can only reach its vetted
 * addresses. The Host header and TLS SNI and certificate check still use the
 * hostname, so the receiver sees an ordinary request.
 *
 * Redirects are not followed: http.request never follows them, and a 3xx is
 * reported as its status. A receiver that redirects could otherwise send the
 * signed payload anywhere, private addresses included.
 */
export function postToVettedTarget(
  target: VettedWebhookTarget,
  request: WebhookRequest,
  mayConnectTo: AddressPolicy = isPublic,
): Promise<{ status: number }> {
  const { url, hostname } = target;
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = Buffer.from(request.body);
  // net.connect skips the lookup for an IP literal, so a literal is checked
  // here instead.
  if (net.isIP(hostname) && !mayConnectTo(hostname)) {
    return Promise.reject(new Error('Webhook target is a private address'));
  }

  return new Promise((resolve, reject) => {
    const req = transport.request({
      method: 'POST',
      hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      headers: { ...request.headers, Host: url.host, 'Content-Length': String(body.length) },
      lookup: pinnedLookup(target.addresses, mayConnectTo),
      // No pooled socket: one kept alive for this host:port would not have
      // gone through the lookup above for this request.
      agent: false,
      // SNI cannot carry an IP address; for a literal there is no name to send.
      ...(isHttps && !net.isIP(hostname) ? { servername: hostname } : {}),
      // The socket also gives up after this long silent, so a stall before
      // headers ends even apart from the deadline below.
      timeout: request.timeoutMs,
    });
    // ETIMEDOUT, as the OS gives a connect that times out: the service cools
    // the endpoint down on it, whichever of the two gave up first.
    const fail = (message: string) => req.destroy(Object.assign(new Error(message), { code: 'ETIMEDOUT' }));
    // One deadline from the start of connect until the status line and
    // headers arrive. An idle timeout alone would not do: a receiver that
    // sends one byte at a time resets it forever.
    const timer = setTimeout(() => fail(`Webhook timed out after ${request.timeoutMs}ms`), request.timeoutMs);
    req.on('timeout', () => fail(`Webhook socket idle for ${request.timeoutMs}ms`));
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      resolve({ status: res.statusCode ?? 0 });
      // Only the status is used. The body is dropped and the socket closed at
      // once rather than drained: draining has no time or size limit, so a
      // receiver trickling a body forever would hold the socket open, and
      // with every click firing a webhook those pile up until EMFILE.
      res.on('error', () => undefined);
      res.destroy();
      req.destroy();
    });
    req.end(body);
  });
}
