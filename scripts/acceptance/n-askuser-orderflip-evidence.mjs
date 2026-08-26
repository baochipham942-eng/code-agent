import { chromium } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';

const baseUrl = process.env.N_ASKUSER_BASE_URL || 'http://127.0.0.1:8282';
const shotDir = process.env.N_ASKUSER_SHOT_DIR;
const phase = process.env.N_ASKUSER_PHASE || 'before';

if (!shotDir) throw new Error('N_ASKUSER_SHOT_DIR is required');
await fs.mkdir(shotDir, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, deviceScaleFactor: 2 });

async function dismissOverlays() {
  for (const name of ['信任并加载', '跳过，稍后在设置里配置', '返回应用']) {
    const button = page.getByRole('button', { name });
    if (await button.isVisible({ timeout: 2_000 }).catch(() => false)) await button.click();
  }
}

async function emit(events) {
  const response = await page.evaluate(async ({ events: payload }) => {
    const token = window.__CODE_AGENT_TOKEN__;
    const result = await fetch('/api/dev/emit-agent-events', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ events: payload }),
    });
    return { ok: result.ok, status: result.status, text: await result.text() };
  }, { events });
  if (!response.ok) throw new Error(`emit failed: ${response.status} ${response.text}`);
}

async function inject(messages) {
  await page.evaluate((nextMessages) => {
    const hook = window.__modelStrategyE2E;
    if (!hook?.injectMessages) throw new Error('Missing ?e2e=1 message injection hook');
    hook.injectMessages(nextMessages);
  }, messages);
  await page.waitForTimeout(250);
}

async function capture(index, name) {
  const file = path.join(shotDir, `${String(index).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file });
  const evidence = await page.evaluate(() => {
    const visible = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
    };
    const candidates = [...document.querySelectorAll('button,[data-testid="thinking-digest"],[data-trace-turn-id]')]
      .filter(visible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName,
          testId: element.getAttribute('data-testid'),
          text: (element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 240),
          top: Number(rect.top.toFixed(2)),
          bottom: Number(rect.bottom.toFixed(2)),
        };
      })
      .filter((item) => /向你提了一个问题|思考|腾讯会议|会议|取消|运行/.test(item.text));
    return {
      phase: document.body.innerText.includes('向你提了一个问题') ? 'label-visible' : 'label-missing',
      candidates,
    };
  });
  await fs.writeFile(`${file}.json`, `${JSON.stringify(evidence, null, 2)}\n`);
  return { file, evidence };
}

const now = Date.now();
const userMessage = {
  id: 'askuser-user', role: 'user', content: '创建一场会议，马上开始', timestamp: now,
};
const askTool = {
  id: 'askuser-tool',
  name: 'AskUserQuestion',
  arguments: { question: '会议主题是什么？', options: ['临时会议', '项目同步会'] },
  result: { toolCallId: 'askuser-tool', success: true, output: '临时会议', duration: 1200 },
};
const askWithoutThinking = {
  id: 'askuser-response', role: 'assistant', content: '', timestamp: now + 100,
  toolCalls: [askTool],
  contentParts: [{ type: 'tool_call', toolCallId: 'askuser-tool' }],
};
const askWithThinking = {
  ...askWithoutThinking,
  reasoning: '用户没有给会议主题，需要先确认一个最小参数。',
};
const createTool = {
  id: 'tmeet-create-tool',
  name: 'tmeetMeetingCreate',
  arguments: { subject: '临时会议', start_time: 'now' },
};
const createResponse = {
  id: 'tmeet-create-response', role: 'assistant', content: '', timestamp: now + 200,
  reasoning: '参数已经齐全，准备创建腾讯会议，等待用户审批。',
  toolCalls: [createTool],
  contentParts: [{ type: 'tool_call', toolCallId: 'tmeet-create-tool' }],
};

await page.goto(`${baseUrl}/?e2e=1`, { waitUntil: 'domcontentloaded' });
await page.locator('.h-screen').waitFor({ state: 'visible', timeout: 20_000 });
await dismissOverlays();
const sessionId = await page.evaluate(async () => {
  const hook = window.__modelStrategyE2E;
  if (!hook?.createSession) throw new Error('Missing ?e2e=1 session hook');
  return hook.createSession(`N-ASKUSER-ORDERFLIP ${Date.now()}`);
});
if (!sessionId) throw new Error('session creation failed');

await emit([{ type: 'turn_start', sessionId, data: { turnId: 'askuser-response' } }]);
await inject([userMessage, askWithoutThinking]);
const frames = [];
frames.push(await capture(1, `${phase}-label-first-appears`));

await inject([userMessage, askWithThinking]);
frames.push(await capture(2, `${phase}-ask-and-thinking-streaming`));

await emit([{ type: 'turn_start', sessionId, data: { turnId: 'tmeet-create-response' } }]);
await inject([userMessage, askWithThinking, createResponse]);
await emit([{
  type: 'permission_request',
  sessionId,
  data: {
    id: 'tmeet-create-permission',
    type: 'command',
    tool: 'tmeetMeetingCreate',
    details: { subject: '临时会议', start_time: 'now' },
    timestamp: now + 250,
  },
}]);
await page.waitForTimeout(250);
frames.push(await capture(3, `${phase}-next-step-awaits-approval`));

await emit([{ type: 'agent_cancelled', sessionId, data: { sessionId } }]);
await inject([
  userMessage,
  askWithThinking,
  {
    ...createResponse,
    toolCalls: [{
      ...createTool,
      result: { toolCallId: 'tmeet-create-tool', success: false, error: '用户取消，未创建会议', duration: 500 },
    }],
  },
  {
    id: 'cancelled-final', role: 'assistant', content: '已取消，未创建会议。', timestamp: now + 300,
  },
]);
frames.push(await capture(4, `${phase}-cancelled-terminal`));

await fs.writeFile(
  path.join(shotDir, `${phase}-dom-order.json`),
  `${JSON.stringify({ baseUrl, sessionId, frames }, null, 2)}\n`,
);
await browser.close();
