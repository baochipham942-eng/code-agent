import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const httpsRequest = vi.fn();
const httpRequest = vi.fn();

vi.mock('https', () => ({
  default: { request: httpsRequest },
  request: httpsRequest,
}));

vi.mock('http', () => ({
  default: { request: httpRequest },
  request: httpRequest,
}));

function makeRequest() {
  const req = new EventEmitter() as EventEmitter & { end: () => void };
  req.end = vi.fn();
  return req;
}

function makeRedirectResponse(location: string) {
  const res = new EventEmitter() as EventEmitter & {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string>;
    pipe: (destination: NodeJS.WritableStream) => NodeJS.WritableStream;
  };
  res.statusCode = 302;
  res.statusMessage = 'Found';
  res.headers = { location };
  res.pipe = vi.fn((destination: NodeJS.WritableStream) => destination);
  return res;
}

async function importUpdateService() {
  const { UpdateService } = await import('../../../../src/main/services/cloud/updateService');
  return UpdateService;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('UpdateService redirect security', () => {
  it('rejects https-to-http redirects for metadata and downloads without making plaintext requests', async () => {
    httpsRequest.mockImplementation((_options, callback) => {
      const req = makeRequest();
      callback(makeRedirectResponse('http://evil.example/update.json'));
      return req;
    });
    httpRequest.mockImplementation(() => {
      const req = makeRequest();
      req.end = vi.fn(() => {
        req.emit('error', new Error('plaintext http request should not be made'));
      });
      return req;
    });

    const UpdateService = await importUpdateService();
    const service = Object.create(UpdateService.prototype) as {
      httpGet: (url: string) => Promise<string>;
      downloadFile: (url: string, destPath: string) => Promise<string>;
    };
    const destPath = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-update-redirect-')),
      'download.bin',
    );

    await expect(service.httpGet('https://updates.example.com/latest.json'))
      .rejects.toThrow(/TLS downgrade redirect/i);
    await expect(service.downloadFile('https://updates.example.com/download.bin', destPath))
      .rejects.toThrow(/TLS downgrade redirect/i);
    expect(httpRequest).not.toHaveBeenCalled();
  });
});
