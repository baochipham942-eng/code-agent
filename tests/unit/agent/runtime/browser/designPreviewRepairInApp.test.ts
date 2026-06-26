import { createServer, type Server } from 'http';
import { createReadStream } from 'fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { runDesignPreviewRepairLoop, type DesignPreviewRepairAgent } from '../../../../../src/host/agent/runtime/browser/designPreviewRepair';
import { browserService } from '../../../../../src/host/services/infra/browserService';

const TOKEN = 'repair-in-app-token';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return address.port;
}

function contentType(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8';
    case '.png':
      return 'image/png';
    default:
      return 'application/octet-stream';
  }
}

function makeWorkspaceFileServer(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', serverRoot: process.cwd() }));
      return;
    }
    if (url.pathname !== '/api/workspace/file') {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (url.searchParams.get('token') !== TOKEN) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }
    const filePath = url.searchParams.get('path');
    if (!filePath) {
      res.writeHead(400);
      res.end('missing path');
      return;
    }
    try {
      const fileStat = await stat(filePath);
      if (!fileStat.isFile()) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      res.setHeader('content-type', contentType(filePath));
      res.setHeader('content-length', String(fileStat.size));
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
}

function badHtml(): string {
  return String.raw`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Bad repair fixture</title></head>
  <body>
    <main data-preview-root>
      <h1>Repair me</h1>
      <p>The first pass has a broken relative image.</p>
      <img alt="broken relative asset" src="./assets/broken.png" />
    </main>
  </body>
</html>`;
}

function repairedHtml(): string {
  return String.raw`<!doctype html>
<html>
  <head><meta charset="utf-8" /><title>Repaired fixture</title></head>
  <body>
    <main data-preview-root>
      <h1>Repaired</h1>
      <p>The repaired pass uses an inline valid image and keeps a visible main root.</p>
      <img alt="valid inline asset" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='20' height='20'%3E%3Crect width='20' height='20' fill='%232563eb'/%3E%3C/svg%3E" />
    </main>
  </body>
</html>`;
}

describe('designPreviewRepair default in-app health runner', () => {
  let cleanupDir: string | null = null;
  let cleanupServer: Server | null = null;

  afterEach(async () => {
    await browserService.close().catch(() => undefined);
    if (cleanupServer) {
      await new Promise<void>((resolve) => cleanupServer?.close(() => resolve()));
      cleanupServer = null;
    }
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
      cleanupDir = null;
    }
  });

  it('runs render -> detect -> repair -> recheck through the default in-app route', async () => {
    cleanupDir = await mkdtemp(path.join(tmpdir(), 'design-repair-in-app-'));
    await mkdir(path.join(cleanupDir, 'assets'), { recursive: true });
    const artifactPath = path.join(cleanupDir, 'index.html');
    await writeFile(artifactPath, badHtml(), 'utf8');
    await writeFile(path.join(cleanupDir, 'assets', 'broken.png'), 'not-a-real-png', 'utf8');
    cleanupServer = makeWorkspaceFileServer();
    const port = await listen(cleanupServer);
    const baseUrl = `http://127.0.0.1:${port}`;
    const repairAgent: DesignPreviewRepairAgent = async ({ spec }) => {
      expect(spec.deterministicFindings.map((finding) => finding.code)).toEqual(['broken_image']);
      await writeFile(artifactPath, repairedHtml(), 'utf8');
      return { success: true, modifiedFiles: [artifactPath] };
    };

    const result = await runDesignPreviewRepairLoop(artifactPath, {
      repairAgent,
      maxAttempts: 1,
      healthOptions: {
        webServerBaseUrl: baseUrl,
        webServerToken: TOKEN,
        viewports: [{ name: 'mobile', width: 390, height: 780 }],
        locale: 'en',
      },
    });

    expect(result.passed).toBe(true);
    expect(result.repairAttempts).toBe(1);
    expect(result.rounds[0].assessment.health.route).toBe('in-app-browser');
    expect(result.finalAssessment.health.route).toBe('in-app-browser');
    expect(result.finalAssessment.findings).toHaveLength(0);
  }, 60_000);
});
