import { PassThrough } from 'stream';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEventEnvelope } from '../../../src/shared/contract';
import type { PermissionAskResult, PermissionRequest } from '../../../src/shared/contract/permission';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  getLogsPath: vi.fn(),
  webContentsSend: vi.fn(),
  addMessageToSession: vi.fn(),
  updateSession: vi.fn(),
  upsertTask: vi.fn(),
  appendEvent: vi.fn(),
  addOutputRef: vi.fn(),
  queueNotification: vi.fn(),
  registryGet: vi.fn(),
}));

vi.mock('child_process', () => ({ spawn: (...args: unknown[]) => mocks.spawn(...args) }));
vi.mock('../../../src/host/platform', () => ({
  getLogsPath: () => mocks.getLogsPath(),
  AppWindow: { getAllWindows: () => [{ webContents: { send: mocks.webContentsSend } }] },
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => ({
    addMessageToSession: mocks.addMessageToSession,
    updateSession: mocks.updateSession,
  }),
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/task/backgroundTaskLedger', () => ({
  getBackgroundTaskLedger: () => ({
    upsertTask: mocks.upsertTask,
    appendEvent: mocks.appendEvent,
    addOutputRef: mocks.addOutputRef,
    queueNotification: mocks.queueNotification,
  }),
}));
vi.mock('../../../src/host/services/agentEngine/agentEngineRegistry', () => ({
  getAgentEngineRegistry: () => ({ get: mocks.registryGet }),
}));

import { KimiAcpAdapter } from '../../../src/host/services/agentEngine/acpClientAdapter';

/**
 * 迷你 ACP agent：按协议真讲 JSON-RPC，不是把 adapter 的内部函数抠出来单测。
 * 这样跑通的是「Neo 作为 client 的整条线」——握手、开会话、发 prompt、
 * 收 session/update、反向调 client 侧方法、拿 stopReason 收尾。
 */
interface FakeAgentOptions {
  /** 该 turn 里 agent 要推给 client 的 session/update 序列。 */
  updates: Array<Record<string, unknown>>;
  /** agent 在 turn 中反向请求的 client 方法（模拟副作用委托）。 */
  clientCalls?: Array<{ method: string; params: Record<string, unknown> }>;
  onClientCallResult?: (method: string, result: unknown, error: unknown) => void;
  loadSessionCalls?: string[];
}

function installFakeAgent(options: FakeAgentOptions) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child: Record<string, unknown> = {
    stdin, stdout, stderr,
    exitCode: null,
    kill: vi.fn(),
    on: vi.fn(),
  };
  mocks.spawn.mockReturnValue(child);

  const send = (payload: unknown) => stdout.write(`${JSON.stringify(payload)}\n`);
  let nextAgentRequestId = 0;
  const pendingClientCalls = new Map<number, string>();
  let buffer = '';

  stdin.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const msg = JSON.parse(line) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };

      // client 对 agent 反向请求的应答
      if (msg.method === undefined && msg.id !== undefined && pendingClientCalls.has(msg.id)) {
        options.onClientCallResult?.(pendingClientCalls.get(msg.id)!, msg.result, msg.error);
        pendingClientCalls.delete(msg.id);
        continue;
      }

      switch (msg.method) {
        case 'initialize':
          send({ jsonrpc: '2.0', id: msg.id, result: {
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            agentInfo: { name: 'fake-acp-agent', version: '0.0.1' },
          } });
          break;
        case 'session/new':
          send({ jsonrpc: '2.0', id: msg.id, result: { sessionId: 'sess-fake-1' } });
          break;
        case 'session/load':
          options.loadSessionCalls?.push(String(msg.params?.sessionId));
          // 真实 agent 会在 load 时把历史当成 session/update 回放（含用户自己的话）
          send({ jsonrpc: '2.0', method: 'session/update', params: {
            sessionId: msg.params?.sessionId,
            update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '这是我上一轮说的话' } },
          } });
          send({ jsonrpc: '2.0', id: msg.id, result: { modes: { currentModeId: 'default' } } });
          break;
        case 'session/prompt': {
          void (async () => {
            for (const call of options.clientCalls ?? []) {
              const id = nextAgentRequestId++;
              pendingClientCalls.set(id, call.method);
              send({ jsonrpc: '2.0', id, method: call.method, params: call.params });
              await new Promise((r) => setTimeout(r, 20));
            }
            for (const update of options.updates) {
              send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-fake-1', update } });
            }
            await new Promise((r) => setTimeout(r, 20));
            send({ jsonrpc: '2.0', id: msg.id, result: { stopReason: 'end_turn' } });
          })();
          break;
        }
        default:
          send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `no handler: ${msg.method}` } });
      }
    }
  });
  return child;
}

let workspace: string;
let logsDir: string;
const events: AgentEventEnvelope[] = [];

beforeEach(async () => {
  workspace = await fsp.mkdtemp(path.join(os.tmpdir(), 'acp-adapter-'));
  logsDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'acp-logs-'));
  events.length = 0;
  for (const m of Object.values(mocks)) m.mockReset?.();
  mocks.getLogsPath.mockReturnValue(logsDir);
  mocks.registryGet.mockResolvedValue({
    kind: 'kimi_code_acp',
    label: 'Kimi Code (ACP)',
    installState: 'installed',
    binaryPath: '/fake/bin/kimi',
    executable: true,
    version: '0.38.0',
    capabilities: ['execute', 'stream_events', 'resume', 'workspace_write'],
  });
  mocks.addMessageToSession.mockResolvedValue(undefined);
  mocks.updateSession.mockResolvedValue(undefined);
});
afterEach(async () => {
  await fsp.rm(workspace, { recursive: true, force: true });
  await fsp.rm(logsDir, { recursive: true, force: true });
});

function baseRequest(extra: Record<string, unknown> = {}) {
  return {
    sessionId: 'neo-session',
    prompt: '回答 OK 两个字',
    cwd: workspace,
    workspaceRoot: workspace,
    emitEvent: (event: AgentEventEnvelope) => { events.push(event); },
    ...extra,
  };
}

describe('AcpClientAdapter — 完整 turn', () => {
  it('把 ACP 事件流译成 Neo 的 turn_start / message_delta / message / turn_end / agent_complete', async () => {
    installFakeAgent({
      updates: [
        { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '想一下' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'O' } },
        { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'K' } },
        { sessionUpdate: 'usage_update', used: 100, size: 1000 },
      ],
    });

    const result = await new KimiAcpAdapter().run(baseRequest() as never);

    expect(result.status).toBe('completed');
    expect(result.outputText).toBe('OK');

    const types = events.map((e) => e.type);
    expect(types[0]).toBe('turn_start');
    expect(types).toContain('message_delta');
    expect(types.slice(-3)).toEqual(['message', 'turn_end', 'agent_complete']);

    const deltas = events.filter((e) => e.type === 'message_delta').map((e) => e.data as { path: string; text: string });
    expect(deltas.filter((d) => d.path === 'content').map((d) => d.text)).toEqual(['O', 'K']);
    expect(deltas.filter((d) => d.path === 'reasoning').map((d) => d.text)).toEqual(['想一下']);
  });
});

describe('AcpClientAdapter — resume 走 session/load', () => {
  it('带上已持久化的 sessionId 时调 session/load，且回放的用户原话不会被当成助手输出', async () => {
    const loadSessionCalls: string[] = [];
    installFakeAgent({
      loadSessionCalls,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '续上了' } }],
    });

    const result = await new KimiAcpAdapter().run(
      baseRequest({ externalSessionId: 'sess-persisted-42' }) as never,
    );

    expect(result.status).toBe('completed');
    expect(loadSessionCalls).toEqual(['sess-persisted-42']);

    // 🔴 回放里那条 user_message_chunk 绝不能变成 assistant 的 content
    const contentText = events
      .filter((e) => e.type === 'message_delta')
      .map((e) => e.data as { path: string; text: string })
      .filter((d) => d.path === 'content')
      .map((d) => d.text)
      .join('');
    expect(contentText).toBe('续上了');
    expect(contentText).not.toContain('上一轮');
    expect(result.outputText).toBe('续上了');
  });
});

describe('AcpClientAdapter — 副作用反向委托过审批链', () => {
  it('agent 请求写文件时弹到注入的审批链；批准后真落盘', async () => {
    const target = path.join(workspace, 'from-agent.txt');
    const asked: Array<Omit<PermissionRequest, 'id' | 'timestamp'>> = [];
    const requestPermission = async (req: Omit<PermissionRequest, 'id' | 'timestamp'>): Promise<PermissionAskResult> => {
      asked.push(req);
      return { approved: true };
    };
    installFakeAgent({
      clientCalls: [{ method: 'fs/write_text_file', params: { sessionId: 'sess-fake-1', path: target, content: 'written-by-agent' } }],
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '写好了' } }],
    });

    const result = await new KimiAcpAdapter().run(baseRequest({ requestPermission }) as never);

    expect(result.status).toBe('completed');
    expect(asked.map((a) => a.tool)).toContain('acp:fs/write_text_file');
    expect(await fsp.readFile(target, 'utf8')).toBe('written-by-agent');
  });

  it('拒绝时 agent 收到错误、文件不落盘，而整个 turn 仍然正常收尾', async () => {
    const target = path.join(workspace, 'denied.txt');
    const seen: Array<{ method: string; error: unknown }> = [];
    installFakeAgent({
      clientCalls: [{ method: 'fs/write_text_file', params: { sessionId: 'sess-fake-1', path: target, content: 'nope' } }],
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '被拒了' } }],
      onClientCallResult: (method, _result, error) => { seen.push({ method, error }); },
    });

    const result = await new KimiAcpAdapter().run(
      baseRequest({ requestPermission: async () => ({ approved: false, denialSource: 'user' as const }) }) as never,
    );

    expect(seen[0]?.method).toBe('fs/write_text_file');
    expect(seen[0]?.error).toBeTruthy();
    await expect(fsp.readFile(target, 'utf8')).rejects.toThrow();
    expect(result.status).toBe('completed');
  });

  /**
   * 🔴 没有注入审批口时不是「跳过审批直接写」，是「拒绝」。
   * 这条挡的是最容易长出来的那个 bug：web/subagent 等入口忘了传 requestPermission，
   * 于是外部 agent 拿到了一个无人看管的写盘通道。
   */
  it('入口忘了接审批链时 fail-closed，不落盘', async () => {
    const target = path.join(workspace, 'unguarded.txt');
    installFakeAgent({
      clientCalls: [{ method: 'fs/write_text_file', params: { sessionId: 'sess-fake-1', path: target, content: 'unguarded' } }],
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });

    await new KimiAcpAdapter().run(baseRequest() as never);

    await expect(fsp.readFile(target, 'utf8')).rejects.toThrow();
  });
});
