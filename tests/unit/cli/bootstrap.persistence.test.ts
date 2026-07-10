import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Message, ModelConfig } from '../../../src/shared/contract';
import {
  installCLISwarmTraceWriterIfNeeded,
  persistAgentLoopMessageToSession,
} from '../../../src/cli/bootstrap';
import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';
import { createSwarmTraceStorageId } from '../../../src/shared/contract/swarm';
import {
  getSwarmTraceWriter,
  resetSwarmTraceWriter,
} from '../../../src/host/agent/swarmTraceWriter';
import { shutdownEventBus } from '../../../src/host/services/eventing/bus';
import { SWARM_TRACE } from '../../../src/shared/constants/storage';

const modelConfig: ModelConfig = {
  provider: 'openai',
  model: 'test-model',
  apiKey: 'test-key',
  temperature: 0,
  maxTokens: 1024,
};

const message: Message = {
  id: 'message-1',
  role: 'assistant',
  content: 'hello',
  timestamp: 123,
};

describe('persistAgentLoopMessageToSession', () => {
  it('persists loop messages to an explicit session without relying on currentSessionId', async () => {
    const manager = {
      addMessage: vi.fn(),
      addMessageToSession: vi.fn().mockResolvedValue(undefined),
    };

    await persistAgentLoopMessageToSession(manager, message, {
      sessionId: 'web-session-1',
      modelConfig,
      workingDirectory: '/tmp/project',
    });

    expect(manager.addMessageToSession).toHaveBeenCalledWith('web-session-1', message, {
      title: 'CLI Session',
      modelConfig,
      workingDirectory: '/tmp/project',
    });
    expect(manager.addMessage).not.toHaveBeenCalled();
  });

  it('keeps the legacy current-session path when no explicit session id is provided', async () => {
    const manager = {
      addMessage: vi.fn().mockResolvedValue(undefined),
      addMessageToSession: vi.fn(),
    };

    await persistAgentLoopMessageToSession(manager, message, {
      modelConfig,
      workingDirectory: '/tmp/project',
    });

    expect(manager.addMessage).toHaveBeenCalledWith(message);
    expect(manager.addMessageToSession).not.toHaveBeenCalled();
  });
});

describe('installCLISwarmTraceWriterIfNeeded', () => {
  let tmpDir: string;
  let savedStorageMode: string | undefined;
  let savedDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-swarm-trace-'));
    savedStorageMode = process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    savedDataDir = process.env.CODE_AGENT_DATA_DIR;
    delete process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
  });

  afterEach(async () => {
    await getSwarmTraceWriter()?.dispose();
    resetSwarmTraceWriter();
    shutdownEventBus();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (savedStorageMode === undefined) delete process.env[SWARM_TRACE.STORAGE_MODE_ENV];
    else process.env[SWARM_TRACE.STORAGE_MODE_ENV] = savedStorageMode;
    if (savedDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = savedDataDir;
  });

  it('does nothing unless CODE_AGENT_SWARM_STORAGE=file', () => {
    expect(installCLISwarmTraceWriterIfNeeded()).toBe(false);
    expect(getSwarmTraceWriter()).toBeNull();
  });

  it('persists swarm events to CODE_AGENT_DATA_DIR/swarm-runs in file mode', async () => {
    process.env[SWARM_TRACE.STORAGE_MODE_ENV] = 'file';

    expect(installCLISwarmTraceWriterIfNeeded()).toBe(true);
    const emitter = new SwarmEventEmitter();
    const scope = {
      sessionId: 'cli-session-1',
      runId: 'cli-run-1',
      treeId: 'cli-tree-1',
    };
    const storageRunId = createSwarmTraceStorageId(scope);
    emitter.started(scope, 1);
    emitter.agentAdded(scope, { id: 'agent_coder_0', name: 'coder', role: 'coder' });
    emitter.agentUpdated(scope, 'agent_coder_0', {
      status: 'running',
      startTime: 10,
      toolCalls: 1,
    });
    emitter.agentCompleted(scope, 'agent_coder_0', 'done');
    emitter.completed(scope, {
      total: 1,
      completed: 1,
      failed: 0,
      parallelPeak: 1,
      totalTime: 100,
    });

    await getSwarmTraceWriter()?.drain();

    const storageDir = path.join(tmpDir, SWARM_TRACE.STORAGE_DIR);
    const files = fs.readdirSync(storageDir).filter((f) => f.endsWith(`__${storageRunId}.jsonl`));
    expect(files).toHaveLength(1);

    const entries = fs
      .readFileSync(path.join(storageDir, files[0]), 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { type: string; sessionId?: string });
    expect(entries.map((entry) => entry.type)).toEqual(
      expect.arrayContaining(['run_started', 'agent_upserted', 'event', 'run_closed']),
    );
    expect(entries.find((entry) => entry.type === 'run_started')?.sessionId).toBe('cli-session-1');
  });
});
