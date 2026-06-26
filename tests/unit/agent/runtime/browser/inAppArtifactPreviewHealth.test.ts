import { createServer, type Server } from 'http';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import type { Page, Route } from 'playwright';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildWorkspaceFileUrl,
  createWorkspaceResourceRoute,
  redactPreviewHealthUrl,
  runInAppArtifactPreviewHealth,
} from '../../../../../src/main/agent/runtime/browser/inAppArtifactPreviewHealth';

const TOKEN = 'unit-test-token';

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server address unavailable');
  return address.port;
}

function makeServer(): Server {
  return createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    if (url.pathname === '/api/health') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ status: 'ok', serverRoot: process.cwd() }));
      return;
    }
    if (url.pathname === '/api/workspace/file') {
      if (url.searchParams.get('token') !== TOKEN) {
        res.writeHead(403);
        res.end('forbidden');
        return;
      }
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<!doctype html><main data-preview-root>fixture</main>');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
}

function makeFakePage(brokenImageSrc: string): Page {
  let viewport = { width: 1280, height: 720 };
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  return {
    on(event: string, handler: (...args: unknown[]) => void) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return this;
    },
    off(event: string, handler: (...args: unknown[]) => void) {
      handlers.get(event)?.delete(handler);
      return this;
    },
    async setViewportSize(size: { width: number; height: number }) {
      viewport = size;
    },
    async goto() {
      return null;
    },
    async waitForTimeout() {},
    async evaluate() {
      return {
        title: 'in-app fixture',
        viewport,
        documentWidth: viewport.width,
        documentHeight: viewport.height,
        bodyTextLength: 12,
        visibleElements: 3,
        horizontalOverflow: false,
        mainElement: { present: true, selector: 'main' },
        brokenImages: [
          {
            src: brokenImageSrc,
            alt: 'missing',
            complete: true,
            naturalWidth: 0,
            naturalHeight: 0,
          },
        ],
      };
    },
  } as unknown as Page;
}

describe('inAppArtifactPreviewHealth', () => {
  let cleanupDir: string | null = null;
  let cleanupServer: Server | null = null;

  afterEach(async () => {
    if (cleanupServer) {
      await new Promise<void>((resolve) => cleanupServer?.close(() => resolve()));
      cleanupServer = null;
    }
    if (cleanupDir) {
      await rm(cleanupDir, { recursive: true, force: true });
      cleanupDir = null;
    }
  });

  it('redacts workspace file tokens from route evidence', () => {
    const url = buildWorkspaceFileUrl('http://127.0.0.1:8180', '/tmp/artifact.html', 'secret-token');

    expect(redactPreviewHealthUrl(url)).toContain('token=%5Bredacted%5D');
    expect(redactPreviewHealthUrl(url)).not.toContain('secret-token');
  });

  it('routes synthetic relative resources back through workspace/file', async () => {
    const continued: string[] = [];
    const route = createWorkspaceResourceRoute({
      artifactPath: path.join('/tmp', 'artifact-root', 'index.html'),
      access: {
        baseUrl: 'http://127.0.0.1:8180',
        token: TOKEN,
        artifactUrl: buildWorkspaceFileUrl('http://127.0.0.1:8180', '/tmp/artifact-root/index.html', TOKEN),
        redactedArtifactUrl: '',
        syntheticResourceBasePath: '/api/workspace',
      },
    });

    const handled = await route({
      request: () => ({ url: () => 'http://127.0.0.1:8180/api/workspace/nested/assets/missing.png' }),
      continue: async (args: { url: string }) => { continued.push(args.url); },
    } as unknown as Route);

    expect(handled).toBe(true);
    expect(continued).toHaveLength(1);
    const continuedUrl = new URL(continued[0]);
    expect(continuedUrl.pathname).toBe('/api/workspace/file');
    expect(continuedUrl.searchParams.get('path')).toBe('/tmp/artifact-root/nested/assets/missing.png');
    expect(redactPreviewHealthUrl(continued[0])).not.toContain(TOKEN);
  });

  it('does not rewrite synthetic resources outside the artifact directory', async () => {
    const continued: string[] = [];
    const route = createWorkspaceResourceRoute({
      artifactPath: path.join('/tmp', 'artifact-root', 'index.html'),
      access: {
        baseUrl: 'http://127.0.0.1:8180',
        token: TOKEN,
        artifactUrl: buildWorkspaceFileUrl('http://127.0.0.1:8180', '/tmp/artifact-root/index.html', TOKEN),
        redactedArtifactUrl: '',
        syntheticResourceBasePath: '/api/workspace',
      },
    });

    const handled = await route({
      request: () => ({ url: () => 'http://127.0.0.1:8180/api/workspace/%2e%2e/outside.png' }),
      continue: async (args: { url: string }) => { continued.push(args.url); },
    } as unknown as Route);

    expect(handled).toBe(false);
    expect(continued).toEqual([]);
  });

  it('returns artifact findings through the in-app route instead of falling back', async () => {
    cleanupDir = await mkdtemp(path.join(tmpdir(), 'in-app-health-unit-'));
    const artifactPath = path.join(cleanupDir, 'index.html');
    await writeFile(artifactPath, '<!doctype html><main data-preview-root>fixture</main>', 'utf8');
    cleanupServer = makeServer();
    const port = await listen(cleanupServer);
    const baseUrl = `http://127.0.0.1:${port}`;
    const brokenImageSrc = `${baseUrl}/api/workspace/assets/missing.png`;
    const browserService = {
      async withIsolatedPage<T>(options: { run: (page: Page) => Promise<T> }): Promise<T> {
        return options.run(makeFakePage(brokenImageSrc));
      },
    };

    const result = await runInAppArtifactPreviewHealth(artifactPath, {
      webServerBaseUrl: baseUrl,
      webServerToken: TOKEN,
      browserService,
      viewports: [{ name: 'mobile', width: 390, height: 780 }],
      locale: 'en',
    });

    expect(result.route).toBe('in-app-browser');
    expect(result.passed).toBe(false);
    expect(result.findings.map((finding) => finding.code)).toEqual(['broken_image']);
    expect(result.findings[0].evidence?.src).toEqual(['artifact-relative:assets/missing.png']);
    expect(result.checks.join('\n')).not.toContain(TOKEN);
  });
});
