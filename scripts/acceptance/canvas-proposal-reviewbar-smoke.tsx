import fs from 'fs';
import os from 'os';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { chromium } from 'playwright';
import { CanvasProposalReviewBar } from '../../src/renderer/components/design/CanvasProposalReviewBar';
import type { CanvasOpProposal } from '../../src/shared/contract/canvasProposal';

const proposal: CanvasOpProposal = {
  requestId: 'cp-smoke',
  rationale: '整理一个带真实交互状态的结账流程',
  ops: [
    {
      kind: 'moveNode',
      nodeId: 'checkout-hover',
      x: 160,
      y: 88,
      intent: '把 hover 态放到默认态右侧，方便 code agent 对齐交互状态。',
      source: 'design_acceptance_contract',
      affectedNodes: ['checkout-hover'],
    },
    {
      kind: 'addConnector',
      fromNodeId: 'checkout-default',
      toNodeId: 'checkout-hover',
      label: 'hover',
      intent: '标出默认态到 hover 态的交互转换。',
      source: 'canvas_snapshot',
      affectedNodes: ['checkout-default', 'checkout-hover'],
    },
    {
      kind: 'addShape',
      shape: { kind: 'sticky', x: 40, y: 260, width: 220, height: 96, text: 'pressed state must remain reachable' },
      intent: '补充验收备注，避免 handoff 时漏掉 pressed 状态。',
      source: 'qa_finding',
      affectedNodes: [],
    },
  ],
};

function buildMarkup(): string {
  return renderToStaticMarkup(
    <CanvasProposalReviewBar
      proposal={proposal}
      onApply={() => undefined}
      onReject={() => undefined}
    />,
  );
}

function buildHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <style>
    body { margin: 0; min-height: 100vh; background: #101114; color: #e4e4e7; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    #stage { position: relative; width: 920px; height: 520px; margin: 24px auto; border: 1px solid #27272a; background: #18181b; overflow: hidden; }
    [data-testid="canvas-proposal-bar"] { position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); width: min(680px, 92%); background: rgba(24, 24, 27, 0.98); border: 1px solid rgba(59, 130, 246, 0.35); border-radius: 8px; padding: 12px; box-shadow: 0 18px 48px rgba(0, 0, 0, 0.38); }
    ul { padding: 0; margin: 8px 0 0; list-style: none; max-height: 220px; overflow: auto; }
    li { margin: 0 0 8px; }
    label { display: flex; align-items: center; gap: 8px; font-size: 12px; }
    [data-testid^="proposal-op-explain-"] { margin-left: 28px; color: #a1a1aa; font-size: 11px; line-height: 1.45; }
    button { margin-left: 8px; }
  </style>
</head>
<body>
  <main id="stage">${buildMarkup()}</main>
</body>
</html>`;
}

async function main(): Promise<void> {
  const outDir = path.join(os.tmpdir(), 'code-agent-stage4');
  fs.mkdirSync(outDir, { recursive: true });
  const htmlPath = path.join(outDir, 'canvas-proposal-reviewbar.html');
  const screenshotPath = path.join(outDir, 'canvas-proposal-reviewbar.png');
  fs.writeFileSync(htmlPath, buildHtml(), 'utf8');

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 560 } });
    await page.goto(`file://${htmlPath}`);
    const explanationCount = await page.locator('[data-testid^="proposal-op-explain-"]').count();
    const text = await page.locator('[data-testid="canvas-proposal-bar"]').innerText();
    const required = [
      '为什么：把 hover 态放到默认态右侧',
      '影响范围：checkout-hover',
      '来源：验收契约',
      '为什么：标出默认态到 hover 态的交互转换',
      '影响范围：checkout-default, checkout-hover',
      '来源：画布快照',
      '影响范围：新增画布元素',
      '来源：QA 发现',
    ];
    const missing = required.filter((item) => !text.includes(item));
    await page.screenshot({ path: screenshotPath, fullPage: true });
    if (explanationCount !== proposal.ops.length || missing.length > 0) {
      throw new Error(`Canvas proposal explanation smoke failed: explanationCount=${explanationCount}, missing=${missing.join(' | ')}`);
    }
    console.log(JSON.stringify({
      ok: true,
      explanationCount,
      screenshotPath,
      htmlPath,
    }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
