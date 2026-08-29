import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Scenario = 'b1-full' | 'b1-filtered' | 'b1-archive';
type Theme = 'light' | 'dark';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.CASELIST_EVIDENCE_DIR ?? path.join(here, 'artifacts', 'screenshots');
const referenceHtml = process.env.CASELIST_REFERENCE_HTML;

if (process.env.NEO_SLOT !== 'caselist') {
  throw new Error('Run with NEO_SLOT=caselist so this visual proof never shares dev/dev2/chatprobe.');
}

async function prepareScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await page.goto(`http://127.0.0.1:4190/?theme=${theme}`);
  await page.getByTestId('eval-case-list-tab').waitFor();
  await page.getByText('显示 153 / 153 题').waitFor();
  if (scenario === 'b1-filtered') {
    await page.getByLabel('评测集').selectOption('held-out');
    await page.getByText(/\u663e\u793a \d+ \/ 153 \u9898/).waitFor();
  }
  if (scenario === 'b1-archive') {
    await page.getByTestId('eval-case-row-bash-pwd').getByRole('button', { name: '归档' }).click();
    await page.getByRole('dialog', { name: '归档题目' }).waitFor();
  }
}

async function captureScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await prepareScenario(page, scenario, theme);
  await page.screenshot({ path: path.join(outputDir, `${scenario}-${theme}.png`), fullPage: false });
}

async function captureReference(page: Page): Promise<void> {
  if (!referenceHtml) return;
  await page.goto(pathToFileURL(referenceHtml).href);
  await page.locator('#b1 .appframe').first().screenshot({ path: path.join(outputDir, 'b1-reference.png') });
}

await fs.mkdir(outputDir, { recursive: true });
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ headless: true });

try {
  for (const scenario of ['b1-full', 'b1-filtered', 'b1-archive'] as const) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
      await captureScenario(page, scenario, theme);
      await page.close();
    }
  }
  if (referenceHtml) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1 });
    await captureReference(page);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`[caselist-visual] captured 6 theme screenshots${referenceHtml ? ' + B1 reference crop' : ''} in ${outputDir}`);
