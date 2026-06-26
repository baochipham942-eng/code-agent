import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import {
  runArtifactPreviewVision,
  type ArtifactPreviewVisionAnalyzer,
} from '../../src/host/agent/runtime/browser/artifactPreviewVision';
import { runArtifactPreviewHealth } from '../../src/host/agent/runtime/browser/artifactPreviewHealth';

const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

const subjectiveBadHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Subjective bad artifact</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
      main { position: relative; width: min(100%, 920px); min-height: 360px; margin: 0 auto; padding: 32px; }
      h1 { font-size: 18px; font-weight: 500; color: #566; margin: 0 0 12px; }
      p { max-width: 56ch; line-height: 1.5; }
      button { padding: 6px 8px; color: #555; background: #eee; border: 1px solid #ddd; }
      .badge { position: absolute; top: 28px; left: 22px; padding: 16px 28px; background: rgba(255,255,255,.92); border: 1px solid #ccd; }
    </style>
  </head>
  <body>
    <main data-preview-root>
      <div class="badge">Trial badge</div>
      <h1>Confirm subscription</h1>
      <p>Choose a plan and continue. This page has visible content and a main region, but the visual hierarchy is weak.</p>
      <button type="button">Continue</button>
    </main>
  </body>
</html>`;

const subjectiveGoodHtml = String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Subjective good artifact</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: system-ui, sans-serif; }
      main { width: min(100%, 920px); min-height: 360px; margin: 0 auto; padding: 32px; }
      h1 { font-size: 34px; font-weight: 720; color: #123; margin: 0 0 12px; }
      p { max-width: 56ch; line-height: 1.5; color: #344; }
      button { padding: 12px 16px; color: #fff; background: #075ec7; border: 0; border-radius: 6px; }
    </style>
  </head>
  <body>
    <main data-preview-root>
      <h1>Confirm subscription</h1>
      <p>Choose a plan and continue. This page has visible content, a clear hierarchy, and a main region.</p>
      <button type="button">Continue</button>
    </main>
  </body>
</html>`;

const mockVisionAnalyzer: ArtifactPreviewVisionAnalyzer = async ({ imagePath }) => {
  const isBad = path.basename(imagePath).startsWith('bad-');
  return {
    ok: true,
    analysis: JSON.stringify({
      findings: isBad
        ? [
          {
            code: 'hierarchy_issue',
            severity: 'high',
            message: 'Primary action is visually buried under secondary content.',
            evidence: 'The main CTA is smaller and lower contrast than surrounding detail text.',
            confidence: 0.9,
          },
          {
            code: 'occlusion_issue',
            severity: 'medium',
            message: 'A sticky badge overlaps the card title.',
            evidence: 'The badge sits on top of the heading area in the supplied screenshot.',
            confidence: 0.82,
          },
        ]
        : [],
    }),
    model: 'mock-vision',
    originalWidth: 1,
    originalHeight: 1,
    analyzedWidth: 1,
    analyzedHeight: 1,
  };
};

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'artifact-preview-vision-dogfood-'));
  try {
    const files = [
      path.join(dir, 'bad-overlap.png'),
      path.join(dir, 'bad-hierarchy.png'),
      path.join(dir, 'good-clean.png'),
      path.join(dir, 'good-brand.png'),
    ];
    await Promise.all(files.map((file) => writeFile(file, ONE_PIXEL_PNG)));
    const badHtmlPath = path.join(dir, 'subjective-bad.html');
    const goodHtmlPath = path.join(dir, 'subjective-good.html');
    await writeFile(badHtmlPath, subjectiveBadHtml, 'utf8');
    await writeFile(goodHtmlPath, subjectiveGoodHtml, 'utf8');

    const deterministicBad = await runArtifactPreviewHealth(badHtmlPath);
    const deterministicGood = await runArtifactPreviewHealth(goodHtmlPath);
    if (!deterministicBad.passed || !deterministicGood.passed) {
      throw new Error(`subjective fixtures must pass deterministic health before vision dogfood: ${JSON.stringify({
        bad: deterministicBad.findings,
        good: deterministicGood.findings,
      }, null, 2)}`);
    }

    const bad = await runArtifactPreviewVision({
      artifactLabel: 'subjective bad fixtures',
      screenshots: files.filter((file) => path.basename(file).startsWith('bad-')).map((imagePath) => ({
        imagePath,
        viewport: 'mobile',
      })),
      brandRefs: ['Primary actions should read as the dominant blue action.'],
    }, mockVisionAnalyzer);

    const good = await runArtifactPreviewVision({
      artifactLabel: 'subjective good fixtures',
      screenshots: files.filter((file) => path.basename(file).startsWith('good-')).map((imagePath) => ({
        imagePath,
        viewport: 'mobile',
      })),
      brandRefs: ['Primary actions should read as the dominant blue action.'],
    }, mockVisionAnalyzer);

    if (bad.passed || bad.findings.length === 0) {
      throw new Error(`bad subjective fixtures should produce vision findings: ${JSON.stringify(bad, null, 2)}`);
    }
    if (!good.passed || good.findings.length > 0) {
      throw new Error(`good subjective fixtures should produce zero vision findings: ${JSON.stringify(good, null, 2)}`);
    }

    console.log(JSON.stringify({
      bad: {
        passed: bad.passed,
        findingCodes: [...new Set(bad.findings.map((finding) => finding.code))],
        findingCount: bad.findings.length,
      },
      good: {
        passed: good.passed,
        findingCodes: good.findings.map((finding) => finding.code),
        findingCount: good.findings.length,
      },
      deterministic: {
        badPassed: deterministicBad.passed,
        goodPassed: deterministicGood.passed,
      },
      note: 'Mocked analyzer dogfood validates vision-layer parsing/routing without spending provider tokens.',
    }, null, 2));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
