// ============================================================================
// SubagentContextStore Tests
// Verifies persistence and recovery of subagent context records.
// ============================================================================

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import path from 'path';
import os from 'os';
import { CompressionState } from '../../../src/main/context/compressionState';
import { SubagentContextStore } from '../../../src/main/context/subagentContextStore';
import type { Message } from '../../../src/shared/contract';
import type { SwarmAgentContextSnapshot } from '../../../src/shared/contract/swarm';

describe('SubagentContextStore', () => {
  let tempDir: string;
  let storePath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'code-agent-subagent-store-'));
    storePath = path.join(tempDir, 'store.json');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists and reloads messages, annotations and compression state', () => {
    const sessionId = 'session-1';
    const agentId = 'agent-1';
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
      {
        id: 't1',
        role: 'tool',
        content: '["result"]',
        toolResults: [{ toolCallId: 'call-1', success: true, output: 'result' }],
        timestamp: 2,
      },
    ];
    const snapshot: SwarmAgentContextSnapshot = {
      currentTokens: 123,
      maxTokens: 456,
      usagePercent: 27,
      messageCount: 2,
      warningLevel: 'normal',
      lastUpdated: 3,
      tools: ['search'],
      attachments: ['report.pdf'],
      previews: [{ role: 'tool', contentPreview: 'tool output', tokens: 50 }],
      truncatedMessages: 0,
    };
    const compressionState = new CompressionState();
    compressionState.applyCommit({
      layer: 'snip',
      operation: 'snip',
      targetMessageIds: ['u1'],
      timestamp: 4,
    });

    const store = new SubagentContextStore(storePath);
    store.upsert({
      sessionId,
      agentId,
      messages,
      snapshot,
      annotations: {
        u1: {
          category: 'recent_turn',
          sourceDetail: 'runtime:user',
          agentId,
          sourceKind: 'message',
        },
        t1: {
          category: 'tool_result',
          sourceDetail: 'search_web',
          agentId,
          sourceKind: 'tool_result',
          toolCallId: 'call-1',
        },
      },
      compressionState,
      maxTokens: 4096,
      updatedAt: Date.now(),
    });

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as { records: unknown[] };
    expect(persisted.records).toHaveLength(1);

    const reloaded = new SubagentContextStore(storePath).get(sessionId, agentId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.messages).toHaveLength(2);
    expect(reloaded?.messages[1].toolResults?.[0]?.output).toBe('result');
    expect(reloaded?.snapshot?.tools).toEqual(['search']);
    expect(reloaded?.annotations?.u1?.sourceDetail).toBe('runtime:user');
    expect(reloaded?.annotations?.t1?.toolCallId).toBe('call-1');
    expect(reloaded?.compressionState?.getCommitLog()).toHaveLength(1);
    expect(reloaded?.maxTokens).toBe(4096);

    if (reloaded) {
      reloaded.messages[0].content = 'mutated locally';
    }
    const reloadedAgain = new SubagentContextStore(storePath).get(sessionId, agentId);
    expect(reloadedAgain?.messages[0].content).toBe('hello');
  });

  it('clearSession removes persisted records for the session', () => {
    const sessionId = 'session-clear';
    const agentId = 'agent-clear';
    const store = new SubagentContextStore(storePath);

    store.upsert({
      sessionId,
      agentId,
      messages: [
        {
          id: 'u1',
          role: 'user',
          content: 'hello',
          timestamp: 1,
        } satisfies Message,
      ],
      updatedAt: Date.now(),
    });

    expect(new SubagentContextStore(storePath).get(sessionId, agentId)).not.toBeNull();

    store.clearSession(sessionId);

    const afterClear = new SubagentContextStore(storePath);
    expect(afterClear.get(sessionId, agentId)).toBeNull();

    const persisted = JSON.parse(readFileSync(storePath, 'utf-8')) as { records: unknown[] };
    expect(persisted.records).toHaveLength(0);
  });
});
