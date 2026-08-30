import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Message } from '../../../src/shared/contract';
import type { DatabaseService } from '../../../src/host/services/core/databaseService';

const loggerMocks = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

const originalCliMode = vi.hoisted(() => {
  const value = process.env.CODE_AGENT_CLI_MODE;
  delete process.env.CODE_AGENT_CLI_MODE;
  return value;
});

interface FakeLoopConfig {
  onEvent: (event: AgentEvent) => void;
  persistMessage?: (message: Message) => Promise<void>;
  sessionId: string;
  turnSnapshotSink?: Pick<DatabaseService, 'insertTurnSnapshot'>;
}

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => loggerMocks,
  logger: loggerMocks,
}));

vi.mock('../../../src/host/platform', () => ({
  app: {
    getName: () => 'Code Agent Test',
    getPath: (name: string) => name === 'userData'
      ? process.env.CODE_AGENT_DATA_DIR
      : '/tmp',
  },
}));

vi.mock('../../../src/host/agent/agentLoop', () => ({
  AgentLoop: class FakeToolProviderLoop {
    constructor(private readonly config: FakeLoopConfig) {}

    async run(): Promise<void> {
      await this.config.persistMessage?.({
        id: 'assistant-tool-call',
        role: 'assistant',
        content: 'I will inspect the file.',
        timestamp: 1_800_000,
        toolCalls: [{ id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } }],
      });
      this.config.turnSnapshotSink?.insertTurnSnapshot({
        sessionId: this.config.sessionId,
        turnId: 'turn-1',
        turnIndex: 1,
        tokenBreakdown: { inputTokens: 4, outputTokens: 3 },
      });
      this.config.onEvent({
        type: 'tool_call_start',
        data: { id: 'tool-1', name: 'read_file', arguments: { path: 'README.md' } },
      });
      this.config.onEvent({
        type: 'tool_call_end',
        data: { toolCallId: 'tool-1', output: 'ok', success: true, duration: 1 },
      });
      this.config.onEvent({
        type: 'message',
        data: { id: 'assistant-done', role: 'assistant', content: 'done', timestamp: 1_800_001 },
      });
    }
  },
}));

vi.mock('../../../src/host/prompts/builder', () => ({
  SYSTEM_PROMPT: 'test system prompt',
}));

vi.mock('../../../src/host/tools/toolExecutor', () => ({
  ToolExecutor: class {},
}));

import { getDatabase } from '../../../src/host/services/core/databaseService';
import { StandaloneAgentAdapter } from '../../../src/host/testing/agentAdapter';
import { createIsolatedEvalState } from '../../../packages/internal/evaluation-center/scripts/lib/eval-isolated-state';

const roots: string[] = [];
let globalDatabase: DatabaseService;
let previousDataDir: string | undefined;

beforeAll(async () => {
  previousDataDir = process.env.CODE_AGENT_DATA_DIR;
  const globalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-global-data-'));
  roots.push(globalRoot);
  process.env.CODE_AGENT_DATA_DIR = globalRoot;
  globalDatabase = getDatabase();
  await globalDatabase.initialize();
  expect(globalDatabase.getDbPath()).toBe(path.join(globalRoot, 'code-agent.db'));
});

afterAll(() => {
  globalDatabase.close();
  if (originalCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
  else process.env.CODE_AGENT_CLI_MODE = originalCliMode;
  if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('StandaloneAgentAdapter isolated persistence', () => {
  it('keeps runtime messages and turn snapshots in the injected evaluation database', async () => {
    const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-isolated-data-'));
    roots.push(isolatedRoot);
    const isolated = await createIsolatedEvalState(isolatedRoot);
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp/eval-worktree',
      modelConfig: { provider: 'fake-tool-provider', model: 'fake-tool-model' },
      sessionType: 'eval',
      database: isolated.database,
      telemetryCollector: isolated.telemetryCollector,
    });

    const result = await adapter.sendMessage('inspect README with one tool call');
    const sessionId = adapter.getSessionId();
    expect(sessionId).toBeDefined();
    expect(result.errors).toEqual([]);
    expect(result.toolExecutions).toHaveLength(1);
    expect(isolated.database.getDb()!.prepare(
      'SELECT session_id, role FROM messages WHERE session_id = ?',
    ).all(sessionId)).toEqual([{ session_id: sessionId, role: 'assistant' }]);
    expect(isolated.database.getDb()!.prepare(
      'SELECT session_id, turn_id FROM turn_snapshots WHERE session_id = ?',
    ).all(sessionId)).toEqual([{ session_id: sessionId, turn_id: 'turn-1' }]);
    expect(globalDatabase.getDb()!.prepare(
      'SELECT COUNT(*) AS count FROM messages WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });
    expect(globalDatabase.getDb()!.prepare(
      'SELECT COUNT(*) AS count FROM turn_snapshots WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });

    await adapter.finalizeSession();
    isolated.database.close();
  });

  it('warns and still attempts session creation when the injected database is not ready', async () => {
    const getSession = vi.fn(() => {
      throw new Error('Database not initialized');
    });
    const adapter = new StandaloneAgentAdapter({
      workingDirectory: '/tmp/eval-worktree',
      modelConfig: { provider: 'fake-tool-provider', model: 'fake-tool-model' },
      database: { isReady: false, getSession } as unknown as DatabaseService,
    });
    const internals = adapter as unknown as {
      currentSessionId: string;
      ensureStandaloneSessionRecord(prompt: string): Promise<void>;
    };
    internals.currentSessionId = 'test-not-ready';

    await internals.ensureStandaloneSessionRecord('warn test');

    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Evaluation session database is not ready; attempting session creation',
      { sessionId: 'test-not-ready' },
    );
    expect(getSession).toHaveBeenCalledWith('test-not-ready');
  });
});
