import { afterAll, beforeAll, describe, it } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { expect as playwrightExpect } from '@playwright/test';
import { createServer, type ViteDevServer } from 'vite';
import path from 'path';

describe('media asset lightbox browser behavior', () => {
  let server: ViteDevServer;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = await createServer({
      configFile: path.resolve(process.cwd(), 'vite.config.ts'),
      server: {
        host: '127.0.0.1',
        port: 0,
        strictPort: false,
      },
      plugins: [{
        name: 'media-asset-lightbox-harness',
        configureServer(viteServer) {
          viteServer.middlewares.use('/__media-harness.html', (_req, res) => {
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Media harness</title>
    <script type="module">
      import { injectIntoGlobalHook } from "/@react-refresh";
      injectIntoGlobalHook(window);
      window.$RefreshReg$ = () => {};
      window.$RefreshSig$ = () => (type) => type;
      window.__vite_plugin_react_preamble_installed__ = true;
    </script>
    <script type="module" src="/@vite/client"></script>
  </head>
  <body style="margin:0;background:#09090b;color:white">
    <div id="root"></div>
  </body>
</html>`);
          });
        },
      }],
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('Vite server did not expose a TCP address');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
  }, 30000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('opens and closes markdown image media lightbox with ownership attributes', async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    try {
      await page.goto(`${baseUrl}/__media-harness.html`, { waitUntil: 'domcontentloaded' });
      await page.addScriptTag({
        type: 'module',
        content: `
          try {
            const ReactModule = await import('/@id/react');
            const React = ReactModule.default || ReactModule;
            const ReactDOM = await import('/@id/react-dom/client');
            const createRoot = ReactDOM.createRoot || ReactDOM.default?.createRoot;
            const { MessageContent } = await import('/components/features/chat/MessageBubble/MessageContent.tsx');
            const rootElement = document.getElementById('root');
            if (!rootElement) throw new Error('Missing root element');
            if (!createRoot) throw new Error('Missing ReactDOM.createRoot');
            const root = createRoot(rootElement);
            root.render(React.createElement(MessageContent, {
              content: '![diagram](/repo/assets/diagram.png)',
              isUser: false,
              messageId: 'assistant-1',
              mediaContext: {
                sessionId: 'browser-smoke-session',
                messageId: 'assistant-1',
              },
            }));
            window.__MEDIA_HARNESS_READY__ = true;
          } catch (error) {
            window.__MEDIA_HARNESS_ERROR__ = error instanceof Error ? error.message : String(error);
            throw error;
          }
        `,
      });
      await page.waitForFunction(() => (
        (window as unknown as Record<string, unknown>)['__MEDIA_HARNESS_READY__']
        || (window as unknown as Record<string, unknown>)['__MEDIA_HARNESS_ERROR__']
      ));
      const harnessError = await page.evaluate(() => (
        (window as unknown as Record<string, unknown>)['__MEDIA_HARNESS_ERROR__']
      ));
      if (harnessError) throw new Error(String(harnessError));

      await page.waitForSelector('button[title="放大查看"]');
      await page.click('button[title="放大查看"]');

      const dialog = page.locator('[role="dialog"]');
      await playwrightExpect(dialog).toHaveAttribute('data-media-session-id', 'browser-smoke-session');
      await playwrightExpect(dialog).toHaveAttribute('data-media-message-id', 'assistant-1');
      await playwrightExpect(dialog).toContainText('来源');
      await playwrightExpect(dialog).toContainText('正文 diagram');

      await page.click('button[title="关闭"]');
      await playwrightExpect(dialog).toHaveCount(0);
    } finally {
      await page.close();
    }
  }, 30000);
});
