import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createExtractRouter } from '../../../src/web/routes/extract';
import type { WebRouteHandler } from '../../../src/web/routes/routeTypes';

let server: http.Server | undefined;
let baseUrl = '';
const tempDirs: string[] = [];

async function startExtractApi(handlers: Map<string, WebRouteHandler>) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api', createExtractRouter({ handlers }));

  server = await new Promise<http.Server>((resolve) => {
    const nextServer = app.listen(0, '127.0.0.1', () => resolve(nextServer));
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP test server address');
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
}

async function closeServer() {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server?.close((err) => (err ? reject(err) : resolve()));
  });
  server = undefined;
  baseUrl = '';
}

function makeTempFile(name: string, content = 'content'): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'extract-router-test-'));
  tempDirs.push(dir);
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

async function postJson(pathname: string, body: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.json() as unknown,
  };
}

afterEach(async () => {
  await closeServer();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('createExtractRouter', () => {
  it('extracts pdf, excel json, and docx html through the matching handlers with resolved file paths', async () => {
    const pdfPath = makeTempFile('sample.pdf');
    const xlsxPath = makeTempFile('sample.xlsx');
    const docxPath = makeTempFile('sample.docx');
    const pdfHandler = vi.fn(async (_event, filePath) => ({ text: `pdf:${path.basename(String(filePath))}` }));
    const excelJsonHandler = vi.fn(async (_event, filePath) => ({ rows: [{ file: path.basename(String(filePath)) }] }));
    const docxHtmlHandler = vi.fn(async (_event, filePath) => ({ html: `<p>${path.basename(String(filePath))}</p>` }));

    await startExtractApi(new Map([
      ['extract-pdf-text', pdfHandler],
      ['extract-excel-json', excelJsonHandler],
      ['extract-docx-html', docxHtmlHandler],
    ]));

    await expect(postJson('/api/extract/pdf', { filePath: pdfPath })).resolves.toEqual({
      status: 200,
      body: { text: 'pdf:sample.pdf' },
    });
    await expect(postJson('/api/extract/excel-json', { filePath: xlsxPath })).resolves.toEqual({
      status: 200,
      body: { rows: [{ file: 'sample.xlsx' }] },
    });
    await expect(postJson('/api/extract/docx-html', { filePath: docxPath })).resolves.toEqual({
      status: 200,
      body: { html: '<p>sample.docx</p>' },
    });
    expect(pdfHandler).toHaveBeenCalledWith(null, path.resolve(pdfPath));
    expect(excelJsonHandler).toHaveBeenCalledWith(null, path.resolve(xlsxPath));
    expect(docxHtmlHandler).toHaveBeenCalledWith(null, path.resolve(docxPath));
  });

  it('rejects missing, traversal, missing file, and missing handler file extraction requests', async () => {
    const filePath = makeTempFile('sample.xlsx');
    await startExtractApi(new Map());

    await expect(postJson('/api/extract/excel', {})).resolves.toEqual({
      status: 400,
      body: { error: 'Missing or invalid filePath' },
    });
    await expect(postJson('/api/extract/excel', { filePath: '../secret.xlsx' })).resolves.toEqual({
      status: 403,
      body: { error: 'Path traversal not allowed' },
    });
    await expect(postJson('/api/extract/excel', { filePath: path.join(path.dirname(filePath), 'missing.xlsx') })).resolves.toEqual({
      status: 404,
      body: { error: `File not found: ${path.join(path.dirname(filePath), 'missing.xlsx')}` },
    });
    await expect(postJson('/api/extract/excel', { filePath })).resolves.toEqual({
      status: 501,
      body: { error: 'extract-excel-text handler not registered' },
    });
  });

  it('passes speech transcription payloads and validates required audio fields', async () => {
    const handler = vi.fn(async (_event, payload) => ({
      text: 'hello',
      payload,
    }));
    await startExtractApi(new Map([
      ['speech:transcribe', handler],
    ]));

    await expect(postJson('/api/speech/transcribe', { audioData: '', mimeType: 'audio/webm' })).resolves.toEqual({
      status: 400,
      body: { error: 'Missing or invalid audioData (base64 string)' },
    });
    await expect(postJson('/api/speech/transcribe', { audioData: 'abc' })).resolves.toEqual({
      status: 400,
      body: { error: 'Missing or invalid mimeType' },
    });
    await expect(postJson('/api/speech/transcribe', {
      audioData: 'abc',
      mimeType: 'audio/webm',
      language: 'en',
      mode: 'local-only',
    })).resolves.toEqual({
      status: 200,
      body: {
        text: 'hello',
        payload: { audioData: 'abc', mimeType: 'audio/webm', language: 'en', mode: 'local-only' },
      },
    });
    expect(handler).toHaveBeenCalledWith(null, {
      audioData: 'abc',
      mimeType: 'audio/webm',
      language: 'en',
      mode: 'local-only',
    });
  });

  it('returns formatted handler errors as HTTP 500 responses', async () => {
    const filePath = makeTempFile('sample.pdf');
    await startExtractApi(new Map([
      ['extract-pdf-text', async () => {
        throw new Error('parse failed');
      }],
      ['speech:transcribe', async () => {
        throw 'speech failed';
      }],
    ]));

    await expect(postJson('/api/extract/pdf', { filePath })).resolves.toEqual({
      status: 500,
      body: { error: 'parse failed' },
    });
    await expect(postJson('/api/speech/transcribe', { audioData: 'abc', mimeType: 'audio/webm' })).resolves.toEqual({
      status: 500,
      body: { error: 'speech failed' },
    });
  });
});
