import * as http from 'http';
import * as net from 'net';
import type { AddressInfo } from 'net';
import { pinnedLookup, postToVettedTarget } from './webhook-delivery';
import type { VettedWebhookTarget } from './webhook-address';

/**
 * Real sockets against a server on loopback. Loopback is private, so these
 * tests pass a policy that allows exactly 127.0.0.1; the default policy is
 * tested separately, refusing the same server.
 */
const onlyLoopback = (address: string) => address === '127.0.0.1';

describe('postToVettedTarget', () => {
  let server: http.Server;
  let port: number;
  let seen: { url: string; host: string | undefined; body: string; headers: http.IncomingHttpHeaders }[];
  let respond: (req: http.IncomingMessage, res: http.ServerResponse) => void;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        seen.push({ url: req.url ?? '', host: req.headers.host, body, headers: req.headers });
        respond(req, res);
      });
    });
    await new Promise<void>((resolve) => server.listen(3401, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    seen = [];
    respond = (_req, res) => res.writeHead(204).end();
  });

  const target = (url: string, address = '127.0.0.1'): VettedWebhookTarget => {
    const parsed = new URL(url);
    return { url: parsed, hostname: parsed.hostname, addresses: [{ address, family: 4 }] };
  };
  const send = { headers: { 'Content-Type': 'application/json', 'X-Chumbaq-Signature': 'sig' }, body: '{"a":1}', timeoutMs: 2000 };

  it('connects to the vetted address and never resolves the name again', async () => {
    // .test never resolves (RFC 6761), so the socket can only have reached
    // the server through the vetted address. Were the name resolved again, as
    // fetch() does, this would fail with ENOTFOUND, and against a TTL-0
    // attacker domain it would connect wherever the second answer pointed.
    const result = await postToVettedTarget(
      target(`http://rebind.example.test:${port}/hook/path?token=abc`),
      send,
      onlyLoopback,
    );

    expect(result.status).toBe(204);
    expect(seen).toHaveLength(1);
    // The receiver still sees its own name, path and query.
    expect(seen[0].host).toBe(`rebind.example.test:${port}`);
    expect(seen[0].url).toBe('/hook/path?token=abc');
    expect(seen[0].body).toBe('{"a":1}');
    expect(seen[0].headers['x-chumbaq-signature']).toBe('sig');
  });

  it('refuses to connect when a vetted address is private under the real policy', async () => {
    await expect(postToVettedTarget(target(`http://name.example.test:${port}/`), send)).rejects.toThrow(
      'No vetted address',
    );
    expect(seen).toHaveLength(0);
  });

  it('refuses a private literal under the real policy, which never reaches a lookup', async () => {
    await expect(postToVettedTarget(target(`http://127.0.0.1:${port}/`), send)).rejects.toThrow(
      'private address',
    );
    expect(seen).toHaveLength(0);
  });

  it('does not follow a redirect, even to an address it may reach', async () => {
    respond = (req, res) =>
      req.url === '/first'
        ? res.writeHead(302, { Location: `http://127.0.0.1:${port}/second` }).end()
        : res.writeHead(200).end();

    const result = await postToVettedTarget(target(`http://hooks.example.test:${port}/first`), send, onlyLoopback);

    expect(result.status).toBe(302);
    expect(seen.map((s) => s.url)).toEqual(['/first']);
  });

  it('gives up at the deadline when the receiver never answers', async () => {
    respond = () => undefined; // hold the request open
    const started = Date.now();
    await expect(
      postToVettedTarget(target(`http://slow.example.test:${port}/`), { ...send, timeoutMs: 200 }, onlyLoopback),
    ).rejects.toThrow('timed out');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});

/**
 * Raw TCP receivers that misbehave below the HTTP layer, where http.Server
 * would not let a test stall on purpose. Each records when its socket closed,
 * since a socket left open is the harm: deliveries are fire-and-forget, so one
 * that outlives its deadline piles up until the API runs out of descriptors.
 */
describe('postToVettedTarget against a stalling receiver', () => {
  let server: net.Server;
  let port: number;
  let sockets: net.Socket[];
  let closedAt: Promise<number>;

  const listen = async (onConnection: (socket: net.Socket) => void) => {
    sockets = [];
    let markClosed: (at: number) => void = () => undefined;
    closedAt = new Promise((resolve) => (markClosed = resolve));
    server = net.createServer((socket) => {
      sockets.push(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => markClosed(Date.now()));
      onConnection(socket);
      // A paused socket never reads the client's FIN, so it would never see
      // the close this suite is measuring.
      socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  };

  afterEach(async () => {
    for (const s of sockets) s.destroy();
    await new Promise((resolve) => server.close(resolve));
  });

  const target = (): VettedWebhookTarget => {
    const parsed = new URL(`http://stall.example.test:${port}/`);
    return { url: parsed, hostname: parsed.hostname, addresses: [{ address: '127.0.0.1', family: 4 }] };
  };
  const send = { headers: {}, body: '{}', timeoutMs: 500 };
  // Close events need a moment to cross loopback; well under any real stall.
  const margin = 300;
  const settled = (at: Promise<number>) =>
    Promise.race([at, new Promise<null>((resolve) => setTimeout(() => resolve(null), send.timeoutMs + margin))]);

  it('closes the socket when the receiver sends headers and then trickles the body forever', async () => {
    const timers: NodeJS.Timeout[] = [];
    await listen((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n');
        timers.push(setInterval(() => socket.writable && socket.write('1\r\nx\r\n'), 50));
      });
    });
    const started = Date.now();
    try {
      await expect(postToVettedTarget(target(), send, onlyLoopback)).resolves.toEqual({ status: 200 });
      const closed = await settled(closedAt);
      expect(closed).not.toBeNull();
      expect((closed as number) - started).toBeLessThanOrEqual(send.timeoutMs + margin);
    } finally {
      timers.forEach(clearInterval);
    }
  });

  it('rejects and closes the socket when the receiver accepts and never sends headers', async () => {
    await listen(() => undefined);
    const started = Date.now();
    // The code is what tells the service the endpoint stalled, so it cools down.
    await expect(postToVettedTarget(target(), send, onlyLoopback)).rejects.toMatchObject({ code: 'ETIMEDOUT' });
    expect(Date.now() - started).toBeLessThanOrEqual(send.timeoutMs + margin);
    const closed = await settled(closedAt);
    expect(closed).not.toBeNull();
    expect((closed as number) - started).toBeLessThanOrEqual(send.timeoutMs + margin);
  });

  it('gives up at the deadline when the receiver trickles the headers themselves', async () => {
    const timers: NodeJS.Timeout[] = [];
    await listen((socket) => {
      socket.once('data', () => {
        socket.write('HTTP/1.1 200 OK\r\n');
        // Every byte resets an idle timeout, so only a deadline ends this.
        timers.push(setInterval(() => socket.writable && socket.write('X-A: b\r\n'), 50));
      });
    });
    const started = Date.now();
    try {
      await expect(postToVettedTarget(target(), send, onlyLoopback)).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        message: expect.stringContaining('timed out'),
      });
      const closed = await settled(closedAt);
      expect(closed).not.toBeNull();
      expect((closed as number) - started).toBeLessThanOrEqual(send.timeoutMs + margin);
    } finally {
      timers.forEach(clearInterval);
    }
  });
});

describe('pinnedLookup', () => {
  const addresses: VettedWebhookTarget['addresses'] = [
    { address: '93.184.216.34', family: 4 },
    { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
  ];
  const call = (lookup: ReturnType<typeof pinnedLookup>, options: object) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup('any.example.com', options as never, ((err: Error | null, address: unknown, family?: number) =>
        resolve({ err, address, family })) as never),
    );

  it('answers with every vetted address when asked for all', async () => {
    expect((await call(pinnedLookup(addresses), { all: true })).address).toEqual(addresses);
  });

  it('answers with the first of the requested family otherwise', async () => {
    expect(await call(pinnedLookup(addresses), { family: 6 })).toMatchObject({
      err: null,
      address: '2606:2800:220:1:248:1893:25c8:1946',
      family: 6,
    });
  });

  it('never hands out a private address, even one passed in as vetted', async () => {
    const result = await call(pinnedLookup([{ address: '::ffff:7f00:1', family: 6 }]), { all: true });
    expect(result.err).toBeInstanceOf(Error);
    expect(result.address).toEqual([]);
  });
});
