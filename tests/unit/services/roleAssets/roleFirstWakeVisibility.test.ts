import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import os from 'os';
import * as path from 'path';
import type { Message } from '../../../../src/shared/contract';

const harness = vi.hoisted(() => ({
  assistantOutput: '',
  configDir: '',
  connected: false,
  loopCalls: [] as Array<{
    config: Record<string, unknown>;
    messages: Message[];
    runPrompt?: string;
    assistantEvent?: Message;
  }>,
  orchestratorPresent: true,
  sendMessage: vi.fn(),
  sessionSeq: 0,
}));

const sessionManager = vi.hoisted(() => ({
  addMessageToSession: vi.fn(),
  createSession: vi.fn(),
  getCurrentSessionId: vi.fn(() => null),
  getSession: vi.fn(),
  updateMessage: vi.fn(),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => harness.configDir,
  getAgentsMdDir: () => ({ user: path.join(harness.configDir, 'agents') }),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => sessionManager,
}));

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: () => ({}) }),
}));

vi.mock('../../../../src/host/services/core/sessionDefaults', () => ({
  resolveSessionDefaultModelConfig: () => ({ provider: 'test', model: 'test' }),
}));

vi.mock('../../../../src/host/task', () => ({
  getTaskManager: () => ({
    getOrCreateCurrentOrchestrator: () => (
      harness.orchestratorPresent ? { sendMessage: harness.sendMessage } : undefined
    ),
    setWorkingDirectory: vi.fn(),
    cleanup: vi.fn(),
  }),
}));

vi.mock('../../../../src/host/services/sessionAutomation', () => ({
  getSessionAutomationService: () => ({
    recordCreated: vi.fn().mockResolvedValue(undefined),
    recordEvent: vi.fn().mockResolvedValue(undefined),
  }),
}));

vi.mock('../../../../src/host/services/capabilities/capabilityCenterService', () => ({
  getCapabilityCenterService: () => ({
    listCapabilities: async () => ({
      items: harness.connected
        ? [{
            kind: 'connector',
            name: '日历',
            source: { kind: 'builtin' },
            tags: ['connector', 'calendar'],
            state: { runtime: 'connected' },
          }]
        : [],
    }),
  }),
}));

vi.mock('../../../../src/host/tools/dispatch/toolDefinitions', () => ({
  getAllToolDefinitions: () => [{ name: 'Read', permissionLevel: 'read' }],
}));

vi.mock('../../../../src/host/agent/agentRegistry', () => ({
  resolveAgent: () => undefined,
}));

vi.mock('../../../../src/cli/adapter', () => ({
  createCLIAgent: async () => {
    const config: Record<string, unknown> = {};
    return { getConfig: () => config };
  },
}));

vi.mock('../../../../src/cli/bootstrap', () => ({
  createAgentLoop: (
    config: Record<string, unknown>,
    onEvent: (event: { type: string; data: Message }) => void,
    messages: Message[],
  ) => {
    const call = { config, messages } as (typeof harness.loopCalls)[number];
    harness.loopCalls.push(call);
    return {
      run: async (prompt: string) => {
        call.runPrompt = prompt;
        call.assistantEvent = {
          id: 'assistant-event',
          role: 'assistant',
          content: harness.assistantOutput,
          timestamp: 2,
        };
        onEvent({ type: 'message', data: call.assistantEvent });
      },
    };
  },
}));

import { enqueueFirstWake } from '../../../../src/host/services/roleAssets/roleFirstWake';

function statePath(roleId: string): string {
  return path.join(harness.configDir, 'roles', roleId, 'first-wake.json');
}

async function waitForCompletion(roleId: string): Promise<void> {
  await vi.waitFor(async () => {
    const state = JSON.parse(await fs.readFile(statePath(roleId), 'utf8')) as { state: string };
    expect(state.state).toBe('completed');
  });
}

beforeEach(async () => {
  harness.configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'role-first-wake-visibility-'));
  harness.assistantOutput = '这是专家介绍。\n```first_wake_suggestions\n[]\n```';
  harness.connected = false;
  harness.loopCalls.length = 0;
  harness.orchestratorPresent = true;
  harness.sendMessage.mockReset().mockResolvedValue(undefined);
  harness.sessionSeq = 0;
  sessionManager.addMessageToSession.mockReset().mockResolvedValue(undefined);
  sessionManager.createSession.mockReset().mockImplementation(async () => ({
    id: `first-wake-${++harness.sessionSeq}`,
    messages: [],
  }));
  sessionManager.getCurrentSessionId.mockReturnValue(null);
  sessionManager.getSession.mockReset().mockImplementation(async (id: string) => ({
    id,
    messages: [{ id: 'assistant-stored', role: 'assistant', content: harness.assistantOutput, timestamp: 2 }],
  }));
  sessionManager.updateMessage.mockReset().mockResolvedValue(undefined);
});

afterEach(async () => {
  await fs.rm(harness.configDir, { recursive: true, force: true });
});

describe.each([
  ['connected', true, '当前已连接的数据源：'],
  ['none', false, '当前没有任何已连接的数据源'],
] as const)('first-wake prompt visibility · %s variant', (_variant, connected, promptMarker) => {
  it('desktop sends the model-facing prompt as meta input without hiding the assistant reply', async () => {
    harness.connected = connected;
    const roleId = `desktop-${connected ? 'connected' : 'none'}`;
    await enqueueFirstWake(roleId);
    await waitForCompletion(roleId);

    expect(harness.sendMessage).toHaveBeenCalledTimes(1);
    const [prompt, , options] = harness.sendMessage.mock.calls[0] as [string, undefined, Record<string, unknown>];
    expect(prompt).toContain(promptMarker);
    expect(options).toMatchObject({ inputHistoryVisibility: 'meta', inputSource: 'automation' });
    expect(options.historyVisibility).toBeUndefined();
  });

  it('headless persists the prompt as meta, keeps it model-facing, and leaves the reply visible', async () => {
    harness.connected = connected;
    harness.orchestratorPresent = false;
    const roleId = `headless-${connected ? 'connected' : 'none'}`;
    await enqueueFirstWake(roleId);
    await waitForCompletion(roleId);

    expect(sessionManager.addMessageToSession).toHaveBeenCalledTimes(1);
    const [sessionId, persistedPrompt] = sessionManager.addMessageToSession.mock.calls[0] as [string, Message];
    expect(sessionId).toBe('first-wake-1');
    expect(persistedPrompt).toMatchObject({
      role: 'user',
      isMeta: true,
      source: 'system',
      content: expect.stringContaining(promptMarker),
    });

    expect(harness.loopCalls).toHaveLength(1);
    const loop = harness.loopCalls[0];
    expect(loop.messages).toEqual([persistedPrompt]);
    expect(loop.runPrompt).toBe(persistedPrompt.content);
    expect(loop.config.historyVisibility).toBeUndefined();
    expect(loop.assistantEvent).toMatchObject({ role: 'assistant', content: harness.assistantOutput });
    expect(loop.assistantEvent?.isMeta).toBeUndefined();
  });
});
