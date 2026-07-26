// ============================================================================
// 这道门守什么、不守什么（实测边界，勿删）
//
// 守得住：
//   - 注入管道会把 source 原样带进 ContextEventLedger（不再写死 'system_message'）
//   - 缓冲合并保留多个来源；无来源时明确落 'unattributed'
//   - category 仍然只控制 hookMessageBuffer 路由，没被 source 改掉语义
//
// 守不住（已实测确认）：
//   - **各个调用点填的 source 值是否正确**。本文件用自建 harness 直接调
//     injectSystemMessage，覆盖的是管道而非那 100 个真实调用点。实测把
//     messageProcessor.ts 的 'tool-spam-hint' 改成 'nudge'，本文件仍全绿。
//   - 兜底的是 typecheck：source 是必填参数且为联合类型，所以「漏填」和
//     「填一个不存在的值」不可能发生；能发生的只有「填成另一个合法但错误的来源」。
//     这类错误只误导账本诊断，不影响运行时行为，因此没有为它建 100 条断言。
//     若将来账本被用于自动决策（而非人工诊断），这条盲区必须先补上。
// ============================================================================
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import type { Message, ToolCall, ToolResult } from '../../../src/shared/contract';
import {
  ContextEventLedger,
  type ContextInjectionSource,
} from '../../../src/host/context/contextEventLedger';
import { HookMessageBuffer } from '../../../src/host/context/tokenOptimizer';
import {
  buildContextEventsForMessage,
  flushHookMessageBuffer,
  injectSystemMessage,
} from '../../../src/host/agent/runtime/contextAssembly/systemContextStack';
import { maybeInjectThinking } from '../../../src/host/agent/runtime/contextAssembly/modeInjection';

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

function makeHarness(options?: {
  hookMessageBuffer?: HookMessageBuffer | {
    add: ReturnType<typeof vi.fn>;
    flush: ReturnType<typeof vi.fn>;
    size: number;
  };
}) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'context-injection-source-'));
  tempDirs.push(tempDir);
  const ledger = new ContextEventLedger(path.join(tempDir, 'ledger.json'));
  let nextId = 0;

  const ctx: any = {
    runtime: {
      sessionId: 'source-session',
      agentId: 'source-agent',
      messages: [] as Message[],
      hookMessageBuffer: options?.hookMessageBuffer ?? new HookMessageBuffer(),
      turn: {
        thinkingStepCount: 1,
        effortLevel: 'medium',
      },
      onEvent: vi.fn(),
    },
    inferBufferedSystemMessageCategory: vi.fn().mockReturnValue(undefined),
    generateId: () => `source-message-${++nextId}`,
    shouldThink: vi.fn().mockReturnValue(true),
    generateThinkingPrompt: vi.fn().mockReturnValue('<thinking>inspect provenance</thinking>'),
  };
  ctx.buildContextEventsForMessage = (message: Message) => buildContextEventsForMessage(ctx, message);
  ctx.recordContextEventsForMessage = (message: Message) => {
    ledger.upsertEvents(ctx.buildContextEventsForMessage(message));
  };
  ctx.injectSystemMessage = (
    content: string,
    source: ContextInjectionSource,
    category?: string,
  ) => injectSystemMessage(ctx, content, source, category);

  return { ctx, ledger };
}

describe('context injection provenance', () => {
  it('records distinct real sources without the legacy system_message detail', async () => {
    const { ctx, ledger } = makeHarness();
    const toolCalls: ToolCall[] = [{
      id: 'call-1',
      name: 'read_file',
      arguments: { path: 'README.md' },
    }];
    const toolResults: ToolResult[] = [{
      toolCallId: 'call-1',
      success: true,
      output: 'ok',
    }];

    await maybeInjectThinking(ctx, toolCalls, toolResults);
    injectSystemMessage(ctx, '<tool-spam>stop searching</tool-spam>', 'tool-spam-hint');
    injectSystemMessage(ctx, 'pre-tool hook payload', 'pre-tool-hook', 'pre-tool-hook');
    flushHookMessageBuffer(ctx);

    const events = ledger.list('source-session', 'source-agent');
    const sourceKinds = new Set(events.map((event) => event.sourceKind));
    const sourceDetails = new Set(events.map((event) => event.sourceDetail));

    expect(sourceKinds).toEqual(new Set([
      'adaptive-thinking',
      'tool-spam-hint',
      'pre-tool-hook',
    ]));
    expect(sourceDetails).toEqual(sourceKinds);
    expect(events.every((event) => event.sourceDetail !== 'system_message')).toBe(true);
    expect(events.every((event) => event.sourceKind !== 'unattributed')).toBe(true);
  });

  it('keeps category as a routing switch independent from source', () => {
    const hookMessageBuffer = {
      add: vi.fn().mockReturnValue(true),
      flush: vi.fn().mockReturnValue(null),
      size: 0,
    };
    const { ctx } = makeHarness({ hookMessageBuffer });

    injectSystemMessage(ctx, 'buffer me', 'pre-tool-hook', 'explicit-hook-category');

    expect(hookMessageBuffer.add).toHaveBeenCalledWith('buffer me', 'explicit-hook-category');
    expect(ctx.runtime.messages).toHaveLength(0);

    injectSystemMessage(ctx, 'inject me directly', 'nudge');

    expect(ctx.runtime.messages).toHaveLength(1);
    expect(ctx.runtime.messages[0].content).toBe('inject me directly');
    expect(hookMessageBuffer.add).toHaveBeenCalledTimes(1);
  });

  it('marks source-less system messages as unattributed instead of hiding the gap', () => {
    const { ctx } = makeHarness();
    const events = buildContextEventsForMessage(ctx, {
      id: 'legacy-system-message',
      role: 'system',
      content: 'legacy system context',
      timestamp: Date.now(),
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      sourceKind: 'unattributed',
      sourceDetail: 'unattributed',
    });
  });
});
