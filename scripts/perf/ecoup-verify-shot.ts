// N-L5-ECOUP 验收截图：起 vite 挂生产 MessageContent，明暗两档各截一张。
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser } from 'playwright';
import { createServer, type ViteDevServer } from 'vite';
import { getFreePort } from '../acceptance/browser-computer-system-chrome';

async function main(): Promise<void> {
  const outDir = path.resolve(process.argv[2] || path.join(process.cwd(), 'docs/evidence/ecoup-verify'));
  const port = await getFreePort();
  let vite: ViteDevServer | null = null;
  let browser: Browser | null = null;
  try {
    fs.mkdirSync(outDir, { recursive: true });
    vite = await createServer({
      appType: 'custom', configFile: false, logLevel: 'error', root: process.cwd(),
      server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
      resolve: { alias: {
        '@': path.resolve('src'), '@host': path.resolve('src/host'),
        '@renderer': path.resolve('src/renderer'), '@shared': path.resolve('src/shared'),
        electron: path.resolve('src/host/platform/index.ts'),
        keytar: path.resolve('tests/__mocks__/keytar.ts'),
      } },
    });
    vite.middlewares.use('/__ecoup.html', (_req, res) => {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8" />
        <title>ECOUP verify</title><style>*{box-sizing:border-box}body{margin:0}</style></head>
        <body><div id="root"></div><script type="module" src="/scripts/perf/ecoup-verify-harness.tsx"></script></body></html>`);
    });
    await vite.listen();
    browser = await chromium.launch();
    for (const theme of ['dark', 'light'] as const) {
      const page = await browser.newPage({ viewport: { width: 960, height: 1400 }, deviceScaleFactor: 2 });
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
      await page.goto(`http://127.0.0.1:${port}/__ecoup.html?theme=${theme}`, { waitUntil: 'networkidle' });
      await page.waitForSelector('body[data-ecoup-ready="true"]', { timeout: 30_000 });
      await page.waitForTimeout(1500);
      const file = path.join(outDir, `ecoup-${theme}.png`);
      await page.screenshot({ path: file, fullPage: true });
      process.stdout.write(`${theme}: ${file}\n`);
      if (errors.length) process.stdout.write(`  ⚠ 控制台错误 ${errors.length} 条：${errors.slice(0, 3).join(' | ')}\n`);
      else process.stdout.write('  控制台零错误\n');
      await page.close();
    }
  } finally {
    await browser?.close();
    await vite?.close();
  }
}

void main();
