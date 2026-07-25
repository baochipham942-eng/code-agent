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
