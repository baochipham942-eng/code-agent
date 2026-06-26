import { createServer, type Server } from 'http';
import { createReadStream } from 'fs';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  runArtifactPreviewHealth,
  runSelfStartedArtifactPreviewHealth,
  type ArtifactPreviewHealthFinding,
} from '../../../../../src/main/agent/runtime/browser/artifactPreviewHealth';
import { browserService } from '../../../../../src/main/services/infra/browserService';

const TOKEN = 'parity-token';
const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 720 },
  { name: 'mobile', width: 390, height: 780 },
];

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
    case '.css':
      return 'text/css; charset=utf-8';
    case '.js':
      return 'text/javascript; charset=utf-8';
    case '.svg':
      return 'image/svg+xml';
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

async function writeParityFixture(root: string): Promise<string> {
  await mkdir(path.join(root, 'styles'), { recursive: true });
  await mkdir(path.join(root, 'scripts'), { recursive: true });
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'nested', 'images'), { recursive: true });
  await writeFile(path.join(root, 'styles', 'site.css'), [
    'main[data-preview-root] { display: block !important; min-height: 220px; padding: 24px; }',
    '.relative-css-loaded { max-width: 42rem; }',
  ].join('\n'), 'utf8');
  await writeFile(path.join(root, 'scripts', 'app.js'), [
    "window.__relativeJsLoaded = true;",
    "console.error('seed-relative-js-error');",
  ].join('\n'), 'utf8');
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#2563eb"/></svg>';
  await writeFile(path.join(root, 'assets', 'ok.svg'), svg, 'utf8');
  await writeFile(path.join(root, 'nested', 'images', 'ok.svg'), svg, 'utf8');
  await writeFile(path.join(root, 'nested', 'images', 'broken.png'), 'not-a-real-png', 'utf8');
  const html = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Preview health parity fixture</title>
    <link rel="stylesheet" href="./styles/site.css" />
    <script src="./scripts/app.js"></script>
  </head>
  <body>
    <main data-preview-root style="display:none">
      <h1>Relative resource parity fixture</h1>
      <p class="relative-css-loaded">This artifact requires relative CSS and JS to load before the probe runs.</p>
      <img alt="top-level ok" src="./assets/ok.svg" />
      <img alt="nested ok" src="./nested/images/ok.svg" />
      <img alt="nested broken" src="./nested/images/broken.png" />
    </main>
  </body>
</html>`;
  const artifactPath = path.join(root, 'index.html');
  await writeFile(artifactPath, html, 'utf8');
  return artifactPath;
}

function comparableFindings(findings: ArtifactPreviewHealthFinding[]): ArtifactPreviewHealthFinding[] {
  return findings.map((finding) => ({
    ...finding,
    evidence: finding.evidence
      ? Object.fromEntries(Object.entries(finding.evidence).sort(([a], [b]) => a.localeCompare(b)))
      : undefined,
  }));
}

describe('artifact preview health route parity', () => {
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

  it('keeps full findings equal for in-app and self-started routes with relative resources', async () => {
    cleanupDir = await mkdtemp(path.join(tmpdir(), 'artifact-preview-parity-'));
    const artifactPath = await writeParityFixture(cleanupDir);
    cleanupServer = makeWorkspaceFileServer();
    const port = await listen(cleanupServer);
    const baseUrl = `http://127.0.0.1:${port}`;

    const inApp = await runArtifactPreviewHealth(artifactPath, {
      webServerBaseUrl: baseUrl,
      webServerToken: TOKEN,
      viewports: VIEWPORTS,
      locale: 'en',
    });
    const fallback = await runSelfStartedArtifactPreviewHealth(artifactPath, {
      viewports: VIEWPORTS,
      locale: 'en',
    });

    expect(inApp.route).toBe('in-app-browser');
    expect(fallback.route).toBe('self-started-chrome');
    expect(comparableFindings(inApp.findings)).toEqual(comparableFindings(fallback.findings));
    expect(inApp.checks.join('\n')).not.toContain(TOKEN);
    expect(inApp.findings.map((finding) => finding.code)).toEqual([
      'broken_image',
      'broken_image',
      'console_error',
    ]);
    expect(inApp.findings[0].evidence?.src).toEqual(['artifact-relative:nested/images/broken.png']);
  }, 60_000);

  it('falls back when webServer is unavailable and records the route explicitly', async () => {
    cleanupDir = await mkdtemp(path.join(tmpdir(), 'artifact-preview-fallback-'));
    const artifactPath = await writeParityFixture(cleanupDir);

    const result = await runArtifactPreviewHealth(artifactPath, {
      webServerBaseUrl: 'http://127.0.0.1:9',
      webServerToken: TOKEN,
      viewports: [{ name: 'mobile', width: 390, height: 780 }],
      locale: 'en',
    });

    expect(result.route).toBe('self-started-chrome');
    expect(result.fallbackReason).toBeTruthy();
    expect(result.checks[0]).toContain('fell back to self-started Chrome');
  }, 60_000);
});
