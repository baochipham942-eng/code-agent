import { chromium, type Page } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

type Scenario = 'a1' | 'a2' | 'a8' | 'a12' | 'c2';
type Theme = 'light' | 'dark';

const here = path.dirname(fileURLToPath(import.meta.url));
const outputDir = process.env.RUNPANEL_EVIDENCE_DIR ?? path.join(here, 'artifacts', 'screenshots');
const referenceHtml = process.env.RUNPANEL_REFERENCE_HTML;
const scenarioNames = new Set<Scenario>(['a1', 'a2', 'a8', 'a12', 'c2']);
const requestedScenarios = (process.env.RUNPANEL_SCENARIOS?.split(',') ?? [...scenarioNames])
  .map((value) => value.trim())
  .filter((value): value is Scenario => scenarioNames.has(value as Scenario));

if (requestedScenarios.length === 0) throw new Error('RUNPANEL_SCENARIOS contains no known scenario.');

if (process.env.NEO_SLOT !== 'runpanel') {
  throw new Error('Run with NEO_SLOT=runpanel so this visual proof never shares dev/dev2/chatprobe.');
}

async function prepareScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await page.goto(`http://127.0.0.1:4189/?scenario=${scenario}&theme=${theme}`);
  if (scenario === 'c2') {
    await page.getByTestId('eval-scorers-tab').waitFor();
    return;
  }
  await page.getByTestId('eval-benchmarks-tab').waitFor();
  if (scenario === 'a2' || scenario === 'a8') {
    await page.getByRole('button', { name: '开跑', exact: true }).click();
    await page.getByRole('dialog').waitFor();
    await page.getByTestId('eval-run-confirm').click();
    await page.getByText(/再点一次确认/).waitFor();
  }
  if (scenario === 'a8') {
    await page.getByTestId('eval-run-confirm').click();
    await page.getByTestId('eval-run-active').waitFor();
    await page.getByText('case-sheet-07', { exact: true }).waitFor();
  }
  if (scenario === 'a12') {
    await page.getByText('日常集 · 每题 1 次 · 题库 abcdef0').waitFor();
  }
}

async function captureScenario(page: Page, scenario: Scenario, theme: Theme): Promise<void> {
  await prepareScenario(page, scenario, theme);
  await page.screenshot({ path: path.join(outputDir, `${scenario}-${theme}.png`), fullPage: scenario === 'c2' });
}

async function captureReference(page: Page, scenario: Scenario): Promise<void> {
  if (!referenceHtml || scenario === 'c2') return;
  await page.goto(pathToFileURL(referenceHtml).href);
  const locator = scenario === 'a1'
    ? page.locator('#a1 .appframe').nth(1)
    : scenario === 'a2'
      ? page.locator('#a2 .modal-backdrop').first()
      : page.locator(`#${scenario} .appframe`).first();
  await locator.screenshot({ path: path.join(outputDir, `${scenario}-reference.png`) });
}

await fs.mkdir(outputDir, { recursive: true });
const server = await createServer({ configFile: path.join(here, 'vite.config.ts'), logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({ headless: true });

try {
  for (const scenario of requestedScenarios) {
    for (const theme of ['light', 'dark'] as const) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
      await captureScenario(page, scenario, theme);
      await page.close();
    }
    if (referenceHtml) {
      const referencePage = await browser.newPage({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
      await captureReference(referencePage, scenario);
      await referencePage.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}

console.log(`[runpanel-visual] captured ${requestedScenarios.length * 2} theme screenshots in ${outputDir}`);
