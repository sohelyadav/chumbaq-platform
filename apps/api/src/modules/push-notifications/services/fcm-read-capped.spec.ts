import * as http from 'http';
import { AddressInfo } from 'net';
import { FCM_MAX_RESPONSE_BYTES, readCapped } from './fcm.provider';

// fcm.provider.spec.ts mocks https, and its fake destroy() always emits
// 'error'. The cap depends on real Node doing the same when a request is
// destroyed mid-response, so this runs readCapped over a real socket.
// Port 3404: this task's port, kept clear of the dev servers.
const PORT = 3404;

describe('readCapped over a real socket', () => {
  let server: http.Server;
  let bodyBytes = 0;

  beforeAll(async () => {
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      const piece = Buffer.alloc(8 * 1024, 'x');
      let sent = 0;
      // Streams in pieces, so the cap trips partway through the response.
      const pump = () => {
        while (sent < bodyBytes) {
          sent += piece.length;
          if (!res.write(piece)) return void res.once('drain', pump);
        }
        res.end();
      };
      res.on('error', () => undefined);
      pump();
    });
    await new Promise<void>((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function fetchCapped(): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: (server.address() as AddressInfo).port, path: '/' },
        (res) => readCapped(req, res, resolve, 'response too large'),
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('destroys the request and reports it once the body passes the cap', async () => {
    bodyBytes = FCM_MAX_RESPONSE_BYTES * 4;
    await expect(fetchCapped()).rejects.toThrow('response too large');
  });

  it('hands over a body under the cap whole', async () => {
    bodyBytes = 16 * 1024;
    await expect(fetchCapped()).resolves.toHaveLength(16 * 1024);
  });
});
