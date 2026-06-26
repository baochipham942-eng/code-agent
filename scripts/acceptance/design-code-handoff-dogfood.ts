import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import {
  formatDesignCodeHandoffForPrompt,
  normalizeDesignCodeHandoffContext,
  type DesignCodeHandoffContext,
} from '../../src/shared/contract/designHandoff';
import { runArtifactPreviewHealth } from '../../src/host/agent/runtime/browser/artifactPreviewHealth';
import { loadPlaywrightChromium } from '../../src/host/agent/runtime/browser/playwrightRuntime';

function buildImplementedArtifact(handoff: DesignCodeHandoffContext): string {
  const variant = handoff.selectedVariants[0];
  if (!variant) throw new Error('handoff has no selected variant');
  const interaction = variant.interactionStates?.[0];
  if (!interaction?.selector || !interaction.expectedState) {
    throw new Error('dogfood handoff must include a real interaction state');
  }

  return String.raw`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Design Code Handoff Dogfood</title>
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #eef2f7; color: #112033; }
      main { min-height: 100vh; padding: 32px 20px; }
      .stage {
        position: relative;
        width: min(100%, 960px);
        min-height: 620px;
        margin: 0 auto;
        background: #f8fafc;
        border: 1px solid #d8e1ef;
        border-radius: 8px;
        overflow: hidden;
      }
      .checkout-card {
        position: absolute;
        left: ${(variant.bounds.x / 960) * 100}%;
        top: ${(variant.bounds.y / 620) * 100}%;
        width: ${(variant.bounds.width / 960) * 100}%;
        min-height: ${(variant.bounds.height / 620) * 100}%;
        display: grid;
        align-content: start;
        gap: 18px;
        padding: 32px;
        background: #fff;
        border: 1px solid #ccd8e8;
        border-radius: 8px;
        box-shadow: 0 18px 60px rgba(33, 45, 70, .16);
      }
      .eyebrow { margin: 0; color: #0b5fc6; font-size: 13px; font-weight: 800; text-transform: uppercase; letter-spacing: 0; }
      h1 { margin: 0; font-size: 34px; line-height: 1.1; }
      p { margin: 0; max-width: 58ch; line-height: 1.55; color: #38506b; }
      .plans { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
      .plan { padding: 12px; border: 1px solid #d9e3f1; border-radius: 6px; background: #f8fbff; }
      .plan strong { display: block; margin-bottom: 4px; }
      button {
        width: max-content;
        min-height: 44px;
        padding: 12px 18px;
        border: 0;
        border-radius: 6px;
        background: #075ec7;
        color: #fff;
        font-weight: 800;
      }
      #state { min-height: 24px; font-weight: 700; color: #0f7b4f; }
      @media (max-width: 720px) {
        main { padding: 18px 12px; }
        .stage { min-height: 760px; }
        .checkout-card { left: 14px; right: 14px; top: 18px; width: auto; min-height: 0; padding: 22px; }
        .plans { grid-template-columns: 1fr; }
        button { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main data-preview-root>
      <section class="stage" aria-label="absolute-positioned handoff implementation">
        <article class="checkout-card" data-source-variant="${variant.id}" data-coordinate-space="${variant.bounds.coordinateSpace}">
          <p class="eyebrow">Agent Neo handoff</p>
          <h1>${variant.label || 'Checkout variant'}</h1>
          <p>This implementation preserves the selected design variant as a running product surface. The card is positioned from the handoff bounds and adapts below mobile width.</p>
          <div class="plans" aria-label="Plan choices">
            <div class="plan"><strong>Basic</strong><span>Starter workspace</span></div>
            <div class="plan"><strong>Team</strong><span>Shared handoff flow</span></div>
            <div class="plan"><strong>Scale</strong><span>Preview QA included</span></div>
          </div>
          <button id="confirm" type="button">Confirm</button>
          <p id="state">Waiting</p>
        </article>
      </section>
    </main>
    <script>
      document.querySelector('#confirm')?.addEventListener('click', () => {
        document.querySelector('#state').textContent = 'Confirmed';
      });
    </script>
  </body>
</html>`;
}

async function mockCodeAgentImplement(args: {
  handoff: DesignCodeHandoffContext;
  outputPath: string;
}): Promise<{ visibleUserMessage: string }> {
  const prompt = formatDesignCodeHandoffForPrompt(args.handoff);
  if (!prompt) throw new Error('handoff prompt was empty');
  for (const expected of [
    '"mode": "design_to_code_b"',
    '"codeVisibility": "hidden"',
    '"userSuccessSignal": "running_artifact"',
    '"coordinateSpace": "canvas_absolute"',
    '#confirm',
  ]) {
    if (!prompt.includes(expected)) {
      throw new Error(`handoff prompt missed ${expected}`);
    }
  }

  await writeFile(args.outputPath, buildImplementedArtifact(args.handoff), 'utf8');
  return {
    visibleUserMessage: `Running artifact ready: ${args.outputPath}`,
  };
}

async function assertRunningArtifact(artifactPath: string, screenshotPath: string): Promise<void> {
  const health = await runArtifactPreviewHealth(artifactPath);
  if (health.skipped || !health.attempted) {
    throw new Error(`preview health skipped: ${health.checks.join(' | ')}`);
  }
  if (!health.passed) {
    throw new Error(`implemented artifact failed Preview QA: ${JSON.stringify(health.findings, null, 2)}`);
  }

  const playwright = await loadPlaywrightChromium();
  if (!playwright.ok || !playwright.chromium) {
    throw new Error(playwright.error || 'Playwright package unavailable for handoff dogfood.');
  }
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 780 } });
    await page.goto(pathToFileURL(artifactPath).href, { waitUntil: 'domcontentloaded' });
    const coordinateSpace = await page.getAttribute('[data-source-variant="checkout-v2"]', 'data-coordinate-space');
    if (coordinateSpace !== 'canvas_absolute') {
      throw new Error(`expected data-coordinate-space canvas_absolute, got ${coordinateSpace ?? '<empty>'}`);
    }
    await page.click('#confirm');
    const state = await page.textContent('#state');
    if (state !== 'Confirmed') {
      throw new Error(`expected #state to become Confirmed, got ${state ?? '<empty>'}`);
    }
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

async function main() {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-code-handoff-dogfood-'));
  const outputPath = path.join(dir, 'handoff-product.html');
  const screenshotPath = path.join(dir, 'handoff-product-mobile.png');
  const handoff = normalizeDesignCodeHandoffContext({
    selectedVariants: [
      {
        id: 'checkout-v2',
        label: 'Checkout confirmed state',
        sourcePath: path.join(dir, 'selected-variant.png'),
        mediaType: 'image',
        chosen: true,
        bounds: {
          x: 120,
          y: 64,
          width: 720,
          height: 480,
          coordinateSpace: 'canvas_absolute',
        },
        interactionStates: [
          {
            id: 'confirm-click',
            description: 'Click Confirm and reveal the confirmed state.',
            selector: '#confirm',
            trigger: 'click',
            expectedState: '#state text becomes Confirmed',
          },
        ],
      },
    ],
    acceptanceContract: {
      acceptanceCriteria: [
        { id: 'usable-product', text: 'The generated product runs without user code review.', priority: 'must' },
        { id: 'confirm-state', text: 'Confirm click changes visible state to Confirmed.', priority: 'must' },
      ],
      lockedRegions: [
        {
          id: 'checkout-layout-lock',
          nodeId: 'checkout-v2',
          label: 'Signed-off checkout layout',
          preserve: ['layout', 'interaction'],
          lockMode: 'strict',
        },
      ],
      brandRefs: [
        {
          name: 'Neo',
          source: 'manual',
          notes: ['Primary action uses blue and remains visually dominant.'],
        },
      ],
    },
    previewQa: {
      deterministicPassed: true,
      visionPassed: true,
      repairAttempts: 1,
      finalFindingCount: 0,
      checks: ['Design preview repair passed before handoff.'],
    },
    notes: [
      'Use B model: do not expose source diff as the success surface.',
    ],
  });
  if (!handoff) throw new Error('failed to build dogfood handoff context');

  const agentResult = await mockCodeAgentImplement({ handoff, outputPath });
  for (const forbidden of ['```', 'diff --git', 'React diff', 'source export']) {
    if (agentResult.visibleUserMessage.includes(forbidden)) {
      throw new Error(`visible handoff result exposed code-oriented content: ${forbidden}`);
    }
  }

  await assertRunningArtifact(outputPath, screenshotPath);

  console.log(JSON.stringify({
    ok: true,
    selectedVariant: handoff.selectedVariants[0]?.id,
    coordinateSpace: handoff.selectedVariants[0]?.bounds.coordinateSpace,
    interaction: 'selector click updated #state to Confirmed',
    visibleUserMessage: agentResult.visibleUserMessage,
    artifactPath: outputPath,
    screenshotPath,
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
