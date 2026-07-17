// ============================================================================
// handleTempUpload 行为：multipart 字段完整性、大小上限、路径穿越、坏 Content-Type。
// 历史上 relativePath 字段截断会丢目录层级；本文件用真实 multipart body 回归。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import type { Request, Response } from 'express';
import {
  MAX_UPLOAD_SIZE,
  UPLOAD_ROOT_DIR,
  cleanupUploadDirs,
  handleTempUpload,
} from '../../../src/web/helpers/upload';

function buildMultipart(parts: Array<{
  name: string;
  filename?: string;
  value: string | Buffer;
  contentType?: string;
}>, boundary = '----CodeAgentBoundary'): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`,
      ));
      chunks.push(Buffer.from(
        `Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
      ));
    } else {
      chunks.push(Buffer.from(
        `Content-Disposition: form-data; name="${part.name}"\r\n\r\n`,
      ));
    }
    chunks.push(Buffer.isBuffer(part.value) ? part.value : Buffer.from(part.value));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeReq(body: Buffer, contentType: string): Request {
  const stream = Readable.from([body]) as unknown as Request;
  (stream as Request).header = ((name: string) => {
    if (name.toLowerCase() === 'content-type') return contentType;
    return undefined;
  }) as Request['header'];
  (stream as Request).headers = { 'content-type': contentType };
  return stream;
}

function makeRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown) {
      this.body = payload;
      return this;
    },
  };
  return res as unknown as Response & typeof res;
}

afterEach(() => {
  cleanupUploadDirs();
  vi.restoreAllMocks();
});

describe('handleTempUpload', () => {
  it('rejects non-multipart content types with 400', async () => {
    const req = makeReq(Buffer.from('raw'), 'application/json');
    const res = makeRes();

    await handleTempUpload(req, res);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({ error: 'Expected multipart/form-data' });
  });

  it('preserves relativePath directory segments (field integrity)', async () => {
    const fileContent = Buffer.from('# hello from nested path');
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'note.md', value: fileContent, contentType: 'text/markdown' },
      { name: 'relativePath', value: 'docs/nested/note.md' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = (res.body as { path: string }).path;
    expect(savedPath).toBeTruthy();
    expect(savedPath.startsWith(UPLOAD_ROOT_DIR)).toBe(true);
    expect(savedPath.replace(/\\/g, '/')).toMatch(/docs\/nested\/note\.md$/);
    expect(fs.readFileSync(savedPath)).toEqual(fileContent);
  });

  it('sanitizes path traversal in relativePath and keeps file under upload dir', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'evil.txt', value: 'payload' },
      { name: 'relativePath', value: '../../etc/passwd' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = path.resolve((res.body as { path: string }).path);
    const uploadRoot = path.resolve(UPLOAD_ROOT_DIR);
    // `..` segments are stripped; remaining names may look like etc/passwd but
    // must still resolve strictly inside the temp upload root (no host escape).
    expect(savedPath.startsWith(uploadRoot + path.sep)).toBe(true);
    expect(path.relative(uploadRoot, savedPath).startsWith('..')).toBe(false);
    expect(fs.existsSync(savedPath)).toBe(true);
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('payload');
  });

  it('rejects uploads that exceed MAX_UPLOAD_SIZE', async () => {
    // Don't allocate 50MB+; stream more than the limit via a synthetic Readable.
    const boundary = '----OversizeBoundary';
    const header = Buffer.from(
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="file"; filename="big.bin"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n',
    );
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    // body size = header + data + footer; data alone exceeds MAX_UPLOAD_SIZE
    const oversize = MAX_UPLOAD_SIZE + 1024;
    const dataChunk = Buffer.alloc(64 * 1024, 0x61);

    const stream = new Readable({
      read() {
        // no-op; we push below
      },
    }) as unknown as Request & Readable;

    (stream as Request).header = ((name: string) => {
      if (name.toLowerCase() === 'content-type') {
        return `multipart/form-data; boundary=${boundary}`;
      }
      return undefined;
    }) as Request['header'];
    (stream as Request).headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    };

    const res = makeRes();
    const pending = handleTempUpload(stream as Request, res);

    stream.push(header);
    let sent = 0;
    while (sent < oversize) {
      const next = Math.min(dataChunk.length, oversize - sent);
      stream.push(dataChunk.subarray(0, next));
      sent += next;
    }
    stream.push(footer);
    stream.push(null);

    await expect(pending).rejects.toThrow(/exceeds .*MB limit/i);
  });

  it('uses basename of filename when relativePath is absent', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'file', filename: 'plain.txt', value: 'just-a-file' },
    ]);
    const res = makeRes();

    await handleTempUpload(makeReq(body, contentType), res);

    expect(res.statusCode).toBe(200);
    const savedPath = (res.body as { path: string }).path;
    expect(path.basename(savedPath)).toBe('plain.txt');
    expect(fs.readFileSync(savedPath, 'utf8')).toBe('just-a-file');
  });
});

describe('handleTempUpload missing file field (error path)', () => {
  it('throws Missing file field when multipart has only text fields', async () => {
    const { body, contentType } = buildMultipart([
      { name: 'relativePath', value: 'only-meta.txt' },
    ]);
    const res = makeRes();

    await expect(handleTempUpload(makeReq(body, contentType), res)).rejects.toThrow(
      /Missing file field/,
    );
  });
});
