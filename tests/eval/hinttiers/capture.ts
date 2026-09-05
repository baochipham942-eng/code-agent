// 截图证据：三条提示同屏，暗/亮两主题各一张。
// 用法：NEO_SLOT=hinttiers HINTTIERS_EVIDENCE_DIR=<dir> HINTTIERS_LABEL=before|after npx tsx tests/eval/hinttiers/capture.ts
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.HINTTIERS_EVIDENCE_DIR ?? path.join(here, 'artifacts');
const label = process.env.HINTTIERS_LABEL ?? 'after';

if (process.env.NEO_SLOT !== 'hinttiers') {
  throw new Error('Run with NEO_SLOT=hinttiers so this visual proof never shares dev/dev2/chatprobe.');
}

await fs.mkdir(outputDir, { recursive: true });
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch();
try {
  for (const theme of ['dark', 'light'] as const) {
    const page = await browser.newPage({ viewport: { width: 940, height: 900 } });
    await page.goto(`http://127.0.0.1:4191/?theme=${theme}`);
    await page.getByTestId('experiment-subagent-not-used').waitFor();
    // 三条提示的实际取色：class 名对不代表 token 解析得出颜色，这里把 computed 值也打出来
    const colors = await page.evaluate(() => ['experiment-blind-hint', 'experiment-memory-not-used', 'experiment-subagent-not-used']
      .map((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return `${id} 不在页面上`;
        const style = getComputedStyle(el);
        return `${id} color=${style.color} bg=${style.backgroundColor} border=${style.borderColor}`;
      }));
    console.log(`[${label}/${theme}]\n  ${colors.join('\n  ')}`);
    await page.locator('[data-testid="eval-experiment-result"]').screenshot({
      path: path.join(outputDir, `hint-tiers-${label}-${theme}.png`),
    });
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}
