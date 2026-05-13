// ============================================================================
// E2E: streaming-ux — 验证批量 agent 事件能进入聊天页并完成前端平滑链路
// ============================================================================

import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentEvent } from '../../src/shared/contract';

type RendererAgentEvent = AgentEvent & { sessionId?: string };

test.setTimeout(60_000);

async function getAuthToken(page: Page): Promise<string> {
  const token = await page.evaluate(() =>
    (window as unknown as Record<string, unknown>).__CODE_AGENT_TOKEN__ as string | undefined,
  );
  expect(token, 'window.__CODE_AGENT_TOKEN__ missing — static.ts token injection broke').toBeTruthy();
  return token!;
}

async function createCleanSession(page: Page): Promise<string> {
  const newSessionBtn = page.getByRole('button', { name: '新会话' });
  await expect(newSessionBtn).toBeVisible({ timeout: 15_000 });
  await newSessionBtn.click();

  const activeSession = page.locator('[data-session-id][aria-current="true"]').first();
  await expect(activeSession).toBeVisible({ timeout: 10_000 });

  const sessionId = await activeSession.getAttribute('data-session-id');
  expect(sessionId, 'active session id missing after creating a clean E2E session').toBeTruthy();
  await expect(page.locator('[data-chat-input]')).toBeVisible({ timeout: 10_000 });

  return sessionId!;
}

async function emitAgentEvents(
  request: APIRequestContext,
  token: string,
  events: RendererAgentEvent[],
): Promise<void> {
  const response = await request.post('/api/dev/emit-agent-events', {
    data: { events },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.ok(),
    `emit-agent-events failed: ${response.status()} ${await response.text()}`,
  ).toBe(true);
}

test('批量 stream_chunk 能经由全局 SSE 渲染到聊天页', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const sessionId = await createCleanSession(page);

  await page.evaluate(() => {
    (window as unknown as {
      __CODE_AGENT_STREAMING_PERF__?: { reset: () => void };
    }).__CODE_AGENT_STREAMING_PERF__?.reset();
  });

  const turnId = `e2e-stream-${Date.now()}`;
  const doneMarker = `STREAM_SMOKE_DONE_${Date.now()}`;
  const chunks = [
    '这是一段来自 E2E 的批量流式文本，',
    '它模拟模型连续输出，',
    '并验证 renderer 侧的平滑显示、低频同步和最终 flush。 ',
    doneMarker,
  ];
  const events: RendererAgentEvent[] = [
    { type: 'turn_start', sessionId, data: { turnId } },
    ...chunks.map((content) => ({
      type: 'stream_chunk' as const,
      sessionId,
      data: { turnId, content },
    })),
    { type: 'turn_end', sessionId, data: { turnId } },
    { type: 'agent_complete', sessionId, data: null },
  ];

  await emitAgentEvents(request, token, events);

  await expect(page.locator(`text=${doneMarker}`).first()).toBeVisible({
    timeout: 15_000,
  });

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as unknown as {
      __CODE_AGENT_STREAMING_PERF__?: { snapshot: () => { counters: Record<string, number>; gauges: Record<string, number> } };
    }).__CODE_AGENT_STREAMING_PERF__?.snapshot();
    return {
      batchEvents: snapshot?.counters['stream.ipc.batch_events'] ?? 0,
      accumulatorAppends: snapshot?.counters['stream.accumulator.append'] ?? 0,
      activeEntries: snapshot?.gauges['stream.accumulator.active_entries'] ?? 0,
    };
  }), { timeout: 10_000 }).toMatchObject({
    batchEvents: expect.any(Number),
    accumulatorAppends: chunks.length,
    activeEntries: 0,
  });

  const metrics = await page.evaluate(() => {
    const snapshot = (window as unknown as {
      __CODE_AGENT_STREAMING_PERF__?: { snapshot: () => { counters: Record<string, number>; gauges: Record<string, number> } };
    }).__CODE_AGENT_STREAMING_PERF__?.snapshot();
    return snapshot;
  });

  expect(metrics?.counters['stream.ipc.batch_received']).toBeGreaterThan(0);
  expect(metrics?.counters['stream.ipc.batch_events']).toBeGreaterThanOrEqual(events.length);
});

test('批量 message_delta 能经由全局 SSE 渲染到聊天页', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const sessionId = await createCleanSession(page);

  const turnId = `e2e-message-delta-${Date.now()}`;
  const doneMarker = `MESSAGE_DELTA_DONE_${Date.now()}`;
  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    {
      type: 'message_delta',
      sessionId,
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: '这是一段 message_delta 文本，',
        turnId,
        messageId: turnId,
      },
    },
    {
      type: 'message_delta',
      sessionId,
      data: {
        role: 'assistant',
        path: 'content',
        op: 'append',
        text: doneMarker,
        turnId,
        messageId: turnId,
      },
    },
    { type: 'turn_end', sessionId, data: { turnId } },
    { type: 'agent_complete', sessionId, data: null },
  ]);

  await expect(page.locator(`text=${doneMarker}`).first()).toBeVisible({
    timeout: 15_000,
  });
});

test('长段 message_delta 结束后能用 message_snapshot 追平草稿', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const sessionId = await createCleanSession(page);

  await page.evaluate(() => {
    (window as unknown as {
      __CODE_AGENT_STREAMING_PERF__?: { reset: () => void };
    }).__CODE_AGENT_STREAMING_PERF__?.reset();
  });

  const turnId = `e2e-long-message-delta-${Date.now()}`;
  const snapshotMarker = `SNAPSHOT_FLUSH_DONE_${Date.now()}`;
  const chunks = Array.from({ length: 36 }, (_, index) => `长回答片段 ${index + 1}，用于模拟持续生成的 markdown 文本。`);
  const accumulatedText = chunks.join('');

  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    ...chunks.map((text, index) => ({
      type: 'message_delta' as const,
      sessionId,
      data: {
        role: 'assistant' as const,
        path: 'content' as const,
        op: 'append' as const,
        text,
        turnId,
        messageId: turnId,
        deltaSeq: index + 1,
      },
    })),
    {
      type: 'message_snapshot',
      sessionId,
      data: {
        role: 'assistant',
        turnId,
        messageId: turnId,
        content: `${accumulatedText}${snapshotMarker}`,
        isFinal: true,
        source: 'main_accumulator',
      },
    },
    { type: 'turn_end', sessionId, data: { turnId } },
    { type: 'agent_complete', sessionId, data: null },
  ]);

  await expect(page.locator(`text=${snapshotMarker}`).first()).toBeVisible({
    timeout: 15_000,
  });

  await expect.poll(async () => page.evaluate(() => {
    const snapshot = (window as unknown as {
      __CODE_AGENT_STREAMING_PERF__?: { snapshot: () => { counters: Record<string, number>; gauges: Record<string, number> } };
    }).__CODE_AGENT_STREAMING_PERF__?.snapshot();
    return {
      accumulatorAppends: snapshot?.counters['stream.accumulator.append'] ?? 0,
      activeEntries: snapshot?.gauges['stream.accumulator.active_entries'] ?? 0,
    };
  }), { timeout: 10_000 }).toMatchObject({
    accumulatorAppends: chunks.length,
    activeEntries: 0,
  });
});

test('tool_output_delta 能显示在 pending 工具详情里', async ({ page, request }) => {
  const ssePromise = page.waitForResponse(
    (resp) => resp.url().includes('/api/events'),
    { timeout: 20_000 },
  );

  await page.goto('/');
  await expect(page.locator('.h-screen')).toBeVisible({ timeout: 15_000 });
  await ssePromise;

  const token = await getAuthToken(page);
  const sessionId = await createCleanSession(page);
  const turnId = `e2e-tool-output-${Date.now()}`;
  const toolCallId = `tool-live-${Date.now()}`;
  const outputMarker = `LIVE_OUTPUT_${Date.now()}`;

  await emitAgentEvents(request, token, [
    { type: 'turn_start', sessionId, data: { turnId } },
    {
      type: 'stream_chunk',
      sessionId,
      data: { turnId, content: 'running live output smoke\n' },
    },
    {
      type: 'stream_tool_call_start',
      sessionId,
      data: { turnId, id: toolCallId, index: 0, name: 'Bash' },
    },
    {
      type: 'tool_call_start',
      sessionId,
      data: {
        turnId,
        id: toolCallId,
        name: 'Bash',
        arguments: { command: `printf "${outputMarker}"` },
        _index: 0,
      },
    },
    {
      type: 'tool_output_delta',
      sessionId,
      data: {
        toolCallId,
        toolName: 'Bash',
        stream: 'stdout',
        content: `${outputMarker}\n`,
      },
    },
  ]);

  await expect(page.getByText('running live output smoke').first()).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText(outputMarker).first()).toBeVisible({ timeout: 10_000 });
});

test('dev agent event route 拒绝格式非法的 body', async ({ page, request }) => {
  await page.goto('/');
  const token = await getAuthToken(page);

  const response = await request.post('/api/dev/emit-agent-events', {
    data: { notAnEvent: true },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(400);
});
