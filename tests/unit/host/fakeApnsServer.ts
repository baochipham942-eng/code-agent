import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Http2Server, type Http2ServerResponse } from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface FakeApnsRequest {
  path: string;
  authorization: string;
  topic: string;
  pushType: string;
  body: string;
}

export interface FakeApnsHandle {
  authority: string;
  requests: FakeApnsRequest[];
  handler: (req: FakeApnsRequest, res: Http2ServerResponse) => void;
  stop(): Promise<void>;
}

export function writeTempApnsKey(): { dir: string; keyPath: string; publicKey: KeyObject } {
  const dir = mkdtempSync(join(tmpdir(), 'companion-apns-'));
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const keyPath = join(dir, 'AuthKey_TESTONLY.p8');
  writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { dir, keyPath, publicKey };
}

export async function listenFakeApns(): Promise<FakeApnsHandle> {
  const requests: FakeApnsRequest[] = [];
  const handle: FakeApnsHandle = {
    authority: '',
    requests,
    handler: (_req, res) => { res.writeHead(200); res.end(); },
    stop: () => closeServer(server),
  };
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => { chunks.push(chunk as Buffer); });
    request.on('end', () => {
      const captured: FakeApnsRequest = {
        path: String(request.headers[':path'] ?? ''),
        authorization: String(request.headers.authorization ?? ''),
        topic: String(request.headers['apns-topic'] ?? ''),
        pushType: String(request.headers['apns-push-type'] ?? ''),
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(captured);
      handle.handler(captured, response);
    });
    request.on('error', () => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  handle.authority = `http://127.0.0.1:${address.port}`;
  return handle;
}

function closeServer(server: Http2Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
}
