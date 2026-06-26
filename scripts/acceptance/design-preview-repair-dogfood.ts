import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  runDesignPreviewRepairLoop,
  type DesignPreviewRepairAgent,
} from '../../src/main/agent/runtime/browser/designPreviewRepair';
import type { ArtifactPreviewVisionAnalyzer } from '../../src/main/agent/runtime/browser/artifactPreviewVision';
import { loadPlaywrightChromium } from '../../src/main/agent/runtime/browser/playwrightRuntime';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const badDesignHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Bad design preview repair fixture</title>
    <style>
      html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
      .shell { position: relative; min-height: 360px; padding: 24px; background: #f6f7f9; }
      .wide-strip { height: 72px; background: #dde8ff; }
      .badge { position: absolute; top: 18px; left: 20px; padding: 30px 52px; background: rgba(255,255,255,.94); border: 1px solid #c9cfdd; }
      button { padding: 6px 8px; color: #666; background: #ececec; border: 1px solid #d7d7d7; }
      @media (max-width: 600px) {
        .wide-strip { width: 920px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <div class="badge">Promo overlay</div>
      <h1>Checkout variant</h1>
      <p>The variant has real text and a target interaction, but the preview has seeded QA failures.</p>
      <img alt="missing preview asset" src="./missing-design-preview-image.png" />
      <button id="confirm" type="button">Confirm</button>
      <p id="state">Waiting</p>
      <div class="wide-strip"></div>
    </div>
    <script>
      console.error('seed-design-preview-repair-console-error');
      document.getElementById('confirm')?.addEventListener('click', () => {
        document.getElementById('state').textContent = 'Confirmed';
      });
    </script>
  </body>
</html>`;

const repairedDesignHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Repaired design preview fixture</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; color: #112033; background: #f6f7f9; }
      main {
        position: relative;
        width: min(100%, 960px);
        min-height: 360px;
        margin: 0 auto;
        padding: clamp(24px, 5vw, 48px);
        display: grid;
        gap: 16px;
      }
      .badge {
        justify-self: start;
        padding: 6px 10px;
        border-radius: 999px;
        color: #0b4ca2;
        background: #e4f0ff;
        border: 1px solid #b7d5ff;
      }
      h1 { margin: 0; font-size: clamp(30px, 6vw, 48px); line-height: 1.05; }
      p { max-width: 64ch; margin: 0; line-height: 1.55; }
      img { width: 72px; height: 72px; }
      button {
        width: max-content;
        min-height: 44px;
        padding: 12px 18px;
        color: #fff;
        background: #075ec7;
        border: 0;
        border-radius: 6px;
        font-weight: 700;
      }
      @media (max-width: 600px) {
        main { padding: 24px 18px; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main data-preview-root data-repaired-design="true">
      <div class="badge">Promo details preserved</div>
      <h1>Checkout variant</h1>
      <p>The repaired variant keeps the original task, removes preview QA defects, and leaves the interaction ready to use.</p>
      <img alt="inline preview asset" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' rx='12' fill='%23075ec7'/%3E%3Cpath d='M20 38l10 10 24-28' fill='none' stroke='white' stroke-width='7' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E" />
      <button id="confirm" type="button">Confirm</button>
      <p id="state">Waiting</p>
    </main>
    <script>
      document.getElementById('confirm')?.addEventListener('click', () => {
        document.getElementById('state').textContent = 'Confirmed';
      });
    </script>
  </body>
</html>`;

async function assertInteractionWorks(artifactPath: string): Promise<void> {
  const playwright = await loadPlaywrightChromium();
  if (!playwright.ok || !playwright.chromium) {
    throw new Error(playwright.error || 'Playwright package unavailable for interaction dogfood.');
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(pathToFileURL(artifactPath).href, { waitUntil: 'domcontentloaded' });
    await page.click('#confirm');
    const state = await page.textContent('#state');
    if (state !== 'Confirmed') {
      throw new Error(`Expected repaired interaction state to be Confirmed, got ${state ?? '<empty>'}`);
    }
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-preview-repair-dogfood-'));
  try {
    const artifactPath = path.join(dir, 'bad-design.html');
    const screenshotPath = path.join(dir, 'bad-design.png');
    await writeFile(artifactPath, badDesignHtml, 'utf8');
    await writeFile(screenshotPath, ONE_PIXEL_PNG);

    const visionAnalyzer: ArtifactPreviewVisionAnalyzer = async () => {
      const html = await readFile(artifactPath, 'utf8');
      const repaired = html.includes('data-repaired-design="true"');
      return {
        ok: true,
        analysis: JSON.stringify({
          findings: repaired
            ? []
            : [
                {
                  code: 'occlusion_issue',
                  severity: 'high',
                  message: 'Promo overlay covers the heading and weakens the primary task.',
                  evidence: 'The absolute badge sits on top of the title zone.',
                  confidence: 0.9,
                },
                {
                  code: 'hierarchy_issue',
                  severity: 'medium',
                  message: 'The confirmation CTA is visually weaker than surrounding content.',
                  evidence: 'The button is low contrast and visually secondary.',
                  confidence: 0.82,
                },
              ],
        }),
        model: 'mock-vision',
        originalWidth: 1,
        originalHeight: 1,
        analyzedWidth: 1,
        analyzedHeight: 1,
      };
    };

    const repairAgent: DesignPreviewRepairAgent = async ({ spec }) => {
      const codes = spec.findings.map((finding) => finding.code);
      for (const expected of ['broken_image', 'missing_main_element', 'console_error', 'occlusion_issue']) {
        if (!codes.includes(expected as typeof codes[number])) {
          throw new Error(`repair spec did not include expected finding ${expected}: ${codes.join(', ')}`);
        }
      }
      await writeFile(artifactPath, repairedDesignHtml, 'utf8');
      return {
        success: true,
        summary: 'Rewrote design artifact from preview repair spec.',
        modifiedFiles: [artifactPath],
      };
    };

    const result = await runDesignPreviewRepairLoop(artifactPath, {
      artifactLabel: 'bad checkout variant with interaction',
      visionInput: {
        screenshots: [{ imagePath: screenshotPath, viewport: 'mobile', role: 'subjective repair fixture' }],
      },
      visionAnalyzer,
      repairAgent,
      maxAttempts: 1,
      acceptanceContract: {
        acceptanceCriteria: [
          'Confirm button updates the visible state without user code edits.',
          'Preview has no horizontal overflow on mobile.',
        ],
        lockedRegions: [
          {
            nodeId: 'checkout-copy',
            label: 'Checkout copy intent',
            preserve: ['content', 'interaction'],
            lockMode: 'best_effort',
          },
        ],
        brandRefs: [
          {
            name: 'Neo',
            source: 'manual',
            notes: ['Primary actions use blue and remain visually dominant.'],
          },
        ],
      },
    });

    if (!result.passed) {
      throw new Error(`design preview repair did not pass: ${JSON.stringify({
        finalFindings: result.finalAssessment.findings,
        escalationReason: result.escalationReason,
      }, null, 2)}`);
    }

    await assertInteractionWorks(artifactPath);

    console.log(JSON.stringify({
      passed: result.passed,
      repairAttempts: result.repairAttempts,
      stateScope: result.stateScope,
      legacyArtifactRepairGuard: result.legacyArtifactRepairGuard,
      initialFindingCodes: result.rounds[0]?.assessment.findings.map((finding) => finding.code),
      finalFindingCount: result.finalAssessment.findings.length,
      interaction: 'selector click updated #state to Confirmed',
      artifactPath,
    }, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
