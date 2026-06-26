import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  runArtifactPreviewHealth,
  type ArtifactPreviewHealthFindingCode,
} from '../../src/host/agent/runtime/browser/artifactPreviewHealth';

const badHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Seeded bad artifact</title>
    <style>
      html, body { margin: 0; min-height: 100%; }
      .shell { min-height: 240px; background: #f7f7f7; }
      .mobile-break { height: 120px; background: #d8e8ff; }
      @media (max-width: 600px) {
        .mobile-break { width: 900px; }
      }
    </style>
  </head>
  <body>
    <div class="shell"><img src="./missing-preview-image.png" /></div>
    <div class="mobile-break"></div>
    <script>console.error('seed-console-error')</script>
  </body>
</html>`;

const goodHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Known good artifact</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
      main {
        width: min(100%, 960px);
        min-height: 360px;
        margin: 0 auto;
        padding: 32px;
        display: grid;
        gap: 16px;
        background: #ffffff;
      }
      img { width: 72px; height: 72px; }
      button { width: max-content; padding: 10px 14px; }
    </style>
  </head>
  <body>
    <main data-preview-root>
      <img alt="inline check" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='72' height='72'%3E%3Crect width='72' height='72' fill='%230b6bcb'/%3E%3C/svg%3E" />
      <h1>Working artifact preview</h1>
      <p>The preview has visible text, a main region, a healthy image, and no horizontal overflow.</p>
      <button type="button">Continue</button>
    </main>
  </body>
</html>`;

function assertCodes(
  actual: readonly ArtifactPreviewHealthFindingCode[],
  expected: readonly ArtifactPreviewHealthFindingCode[],
  label: string,
) {
  const missing = expected.filter((code) => !actual.includes(code));
  if (missing.length > 0) {
    throw new Error(`${label} missing finding code(s): ${missing.join(', ')}. Actual: ${actual.join(', ')}`);
  }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifact-preview-health-dogfood-'));
  try {
    const badPath = path.join(dir, 'bad.html');
    const goodPath = path.join(dir, 'good.html');
    await writeFile(badPath, badHtml, 'utf8');
    await writeFile(goodPath, goodHtml, 'utf8');

    const bad = await runArtifactPreviewHealth(badPath);
    if (bad.skipped || !bad.attempted) {
      throw new Error(`bad artifact dogfood was skipped: ${bad.checks.join(' | ')}`);
    }
    const badCodes = bad.findings.map((finding) => finding.code);
    assertCodes(badCodes, [
      'blank_body_text',
      'horizontal_overflow',
      'console_error',
      'broken_image',
      'missing_main_element',
      'responsive_breakpoint_failure',
    ], 'bad artifact');

    const good = await runArtifactPreviewHealth(goodPath);
    if (good.skipped || !good.attempted) {
      throw new Error(`good artifact dogfood was skipped: ${good.checks.join(' | ')}`);
    }
    if (!good.passed || good.findings.length > 0) {
      throw new Error(`good artifact should have zero findings. Actual: ${JSON.stringify(good.findings, null, 2)}`);
    }

    console.log(JSON.stringify({
      bad: {
        passed: bad.passed,
        findingCodes: [...new Set(badCodes)],
        findingCount: bad.findings.length,
      },
      good: {
        passed: good.passed,
        findingCodes: good.findings.map((finding) => finding.code),
        findingCount: good.findings.length,
      },
    }, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
