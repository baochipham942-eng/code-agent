/* global console, document, process, window */
import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.N_RECEIPT_BASE_URL;
const shotDir = process.env.N_RECEIPT_SHOT_DIR;
if (!baseUrl || !shotDir) throw new Error('N_RECEIPT_BASE_URL and N_RECEIPT_SHOT_DIR are required');

await fs.mkdir(shotDir, { recursive: true });
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(15_000);

async function dismissOverlays() {
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible({ timeout: 1_000 }).catch(() => false)) await button.click();
  }
}

async function inject(messages) {
  await page.evaluate((nextMessages) => {
    const hook = window.__modelStrategyE2E;
    if (!hook?.injectMessages) throw new Error('Missing ?e2e=1 message injection hook');
    hook.injectMessages(nextMessages);
  }, messages);
  await page.waitForTimeout(300);
}

async function capture(name) {
  const file = path.join(shotDir, `${name}.png`);
  await page.screenshot({ path: file });
  const state = await page.evaluate(() => ({
    receiptBlocks: document.querySelectorAll('[data-testid="turn-receipts-toggle"]').length,
    receiptRows: [...document.querySelectorAll('[data-testid="tool-step-receipt-meta"]')]
      .map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim()),
    receiptDetails: [...document.querySelectorAll('[data-testid="tool-step-receipt-detail"]')]
      .map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim()),
    toolRows: [...document.querySelectorAll('[data-testid^="tool-call-row-"]')]
      .map((element) => (element.textContent || '').replace(/\\s+/g, ' ').trim()),
    body: document.body.innerText.slice(-8_000),
  }));
  await fs.writeFile(`${file}.json`, `${JSON.stringify(state, null, 2)}\\n`);
  return { file, state };
}

const now = Date.parse('2026-08-27T07:05:00+08:00');
const userMessage = {
  id: 'receipt-user', role: 'user', content: '看看我最近 1 个会议在什么时候', timestamp: now - 1_000,
};
const baseTools = [
  {
    id: 'receipt-upcoming',
    name: 'tmeetMeetingList',
    arguments: { scope: 'upcoming', limit: 1 },
    stepLabel: 'tmeetMeetingListUpcoming',
  },
  {
    id: 'receipt-ended',
    name: 'tmeetMeetingList',
    arguments: { scope: 'ended', limit: 1 },
    stepLabel: 'tmeetMeetingListEnded',
  },
];
const streamingTools = baseTools.map((toolCall) => ({ ...toolCall, _streaming: true }));
const toolMessage = (toolCalls) => ({
  id: 'receipt-tools', role: 'assistant', content: '', timestamp: now,
  reasoning: '先同时查询待开始和最近结束的会议，再给出最近一场。',
  toolCalls,
  contentParts: toolCalls.map((toolCall) => ({ type: 'tool_call', toolCallId: toolCall.id })),
});
const artifact = (id, name, scope, preview) => ({
  artifactId: `artifact-${id}`,
  kind: 'text',
  role: 'receipt',
  sourceTool: 'tmeetMeetingList',
  createdAt: new Date(now).toISOString(),
  name,
  preview,
  metadata: { connector: 'tmeet', action: 'meeting.list', scope },
});
const completedTools = [
  {
    ...baseTools[0],
    result: {
      toolCallId: 'receipt-upcoming', success: true, duration: 310,
      output: '{"scope":"upcoming","meetings":[]}',
      metadata: {
        artifact: artifact(
          'upcoming',
          '待开始/进行中的腾讯会议',
          'upcoming',
          '{"scope":"upcoming","meetings":[]}',
        ),
      },
    },
  },
  {
    ...baseTools[1],
    result: {
      toolCallId: 'receipt-ended', success: true, duration: 420,
      output: '{"scope":"ended","meetings":[{"subject":"产品周会","startTime":"2026-08-26T07:05:00+08:00"}]}',
      metadata: {
        artifact: artifact(
          'ended',
          '已结束的腾讯会议',
          'ended',
          '{"subject":"产品周会","startTime":"2026-08-26 07:05"}',
        ),
      },
    },
  },
];
const finalMessage = {
  id: 'receipt-final', role: 'assistant',
  content: '最近 1 个会议是「产品周会」，时间为 8 月 26 日 07:05。',
  timestamp: now + 1_000,
};

try {
  await page.goto(`${baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.locator('.h-screen').waitFor({ state: 'visible', timeout: 20_000 });
  await dismissOverlays();
  const sessionId = await page.evaluate(() => {
    const hook = window.__modelStrategyE2E;
    if (!hook?.createSession) throw new Error('Missing ?e2e=1 session hook');
    return hook.createSession(`N-RECEIPT-INTOSTEPS ${Date.now()}`);
  });
  if (!sessionId) throw new Error('session creation failed');

  await inject([userMessage, toolMessage(streamingTools)]);
  const frames = [await capture('01-streaming')];

  await inject([userMessage, toolMessage(completedTools), finalMessage]);

  // Reproduce the persistence handoff gap and then the persisted payload. The
  // mounted group must retain terminal receipt/status presentation throughout.
  await inject([userMessage, toolMessage(baseTools), finalMessage]);
  const handoffState = await page.evaluate(() => ({
    receiptBlocks: document.querySelectorAll('[data-testid="turn-receipts-toggle"]').length,
    groupText: [...document.querySelectorAll('button')]
      .map((element) => element.textContent || '')
      .find((text) => text.includes('腾讯会议') && text.includes('步骤')) || '',
  }));
  await inject([userMessage, toolMessage(completedTools), finalMessage]);
  frames.push(await capture('02-settled'));

  await page.getByRole('button', { name: /腾讯会议 · 执行了 2 个步骤/ }).last().click();
  await page.getByTestId('tool-step-receipt-meta').first().waitFor({ state: 'visible' });
  await page.getByTestId('tool-call-row-tmeetMeetingList').first().click();
  await page.getByTestId('tool-step-receipt-detail').waitFor({ state: 'visible' });
  frames.push(await capture('03-expanded'));

  const finalState = frames.at(-1).state;
  if (frames.some((frame) => frame.state.receiptBlocks !== 0) || handoffState.receiptBlocks !== 0) {
    throw new Error('independent receipt block rendered during replay');
  }
  if (finalState.receiptRows.length !== 2 || finalState.receiptDetails.length !== 1) {
    throw new Error(`expanded receipt projection mismatch: ${JSON.stringify(finalState)}`);
  }
  await fs.writeFile(
    path.join(shotDir, 'run.json'),
    `${JSON.stringify({ baseUrl, sessionId, handoffState, frames }, null, 2)}\\n`,
  );
  console.log(JSON.stringify({ baseUrl, sessionId, handoffState, frames }, null, 2));
} finally {
  await browser.close();
}
