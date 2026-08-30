import { PassThrough } from 'node:stream';
import { EventEmitter } from 'events';
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
  /** true = 收到 session/prompt 后永不作答，用来造「带着在飞请求断开连接」那一态。 */
  hangPrompt?: boolean;
  /** session/new 返回的 configOptions（模型目录等）。 */
  configOptions?: Array<Record<string, unknown>>;
  /** 收集 agent 收到的 session/set_config_option 调用。 */
  configSets?: Array<Record<string, unknown>>;
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
  // 让假子进程像真子进程：kill 之后 exitCode 落定并发 'close'，
  // 否则测不出适配器「等进程真关掉再收日志流」那一步。
  const emitter = new EventEmitter();
  const child: Record<string, unknown> = {
    stdin, stdout, stderr,
    exitCode: null,
    kill: vi.fn(() => {
      if (child.exitCode === null) {
        child.exitCode = 0;
        setTimeout(() => emitter.emit('close', 0, null), 5);
      }
      return true;
    }),
    on: (event: string, handler: (...args: unknown[]) => void) => emitter.on(event, handler),
    once: (event: string, handler: (...args: unknown[]) => void) => emitter.once(event, handler),
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
          send({ jsonrpc: '2.0', id: msg.id, result: {
            sessionId: 'sess-fake-1',
            ...(options.configOptions ? { configOptions: options.configOptions } : {}),
          } });
          break;
        case 'session/set_config_option':
          options.configSets?.push(msg.params ?? {});
          send({ jsonrpc: '2.0', id: msg.id, result: { configOptions: options.configOptions ?? [] } });
          break;
        case 'session/load':
          options.loadSessionCalls?.push(String(msg.params?.sessionId));
          // 真实 agent 在 load 时把**整段历史**当成 session/update 回放：
          // 用户说过的话 + **上一轮的助手正文** + 思考流（2026-08-27 真机抓包形态）。
          for (const replay of [
            { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '这是我上一轮说的话' } },
            { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '上一轮的旧答案' } },
            { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '上一轮的旧思考' } },
          ]) {
            send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: msg.params?.sessionId, update: replay } });
          }
          send({ jsonrpc: '2.0', id: msg.id, result: { modes: { currentModeId: 'default' } } });
          break;
        case 'session/prompt': {
          if (options.hangPrompt) break;
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

  it('descriptor 带版本探活超时痕迹时仍执行本轮，且不向用户回显绝对路径', async () => {
    mocks.registryGet.mockResolvedValue({
      kind: 'kimi_code_acp',
      label: 'Kimi Code (ACP)',
      installState: 'installed',
      binaryPath: '/fake/bin/kimi',
      executable: true,
      capabilities: ['execute', 'stream_events', 'resume', 'workspace_write'],
      lastError: 'Command failed: /fake/bin/kimi --version',
    });
    installFakeAgent({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OK' } }],
    });

    const result = await new KimiAcpAdapter().run(baseRequest() as never);

    expect(result).toMatchObject({ status: 'completed', outputText: 'OK' });
    expect(JSON.stringify(mocks.addMessageToSession.mock.calls)).not.toContain('/fake/bin/kimi');
  });

  it('真实运行失败只落一张结构化会话卡，不再额外发 toast/error 事件', async () => {
    installFakeAgent({ updates: [] });

    const result = await new KimiAcpAdapter().run(baseRequest() as never);

    expect(result.status).toBe('failed');
    expect(mocks.queueNotification).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage).toMatchObject({
      content: '',
      metadata: expect.objectContaining({
        agentError: expect.objectContaining({ category: 'generic' }),
      }),
    });
    expect(JSON.stringify(assistantMessage)).not.toContain('/fake/bin/kimi');
  });
});

describe('AcpClientAdapter — 收尾不许打死宿主进程', () => {
  /**
   * 🔴 2026-08-27 真机实付：turn 结束后适配器 kill 子进程并立刻 end 日志流，
   * 但子进程 stdout 里的缓冲数据还会继续到达 → 往已 end 的 WriteStream 写 →
   * 流发 'error' → **没有监听者的 'error' 在 Node 里会升级成 uncaught exception**，
   * 直接打死整个 webServer 进程（app 失联，日志里只留半句话）。
   * 这条测试模拟「收尾之后子进程还在吐数据」，跑完必须活着。
   */
  it('收尾后摘掉 stdout/stderr 监听器，late data 再也写不进已关闭的日志流', async () => {
    const child = installFakeAgent({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '收尾测试' } }],
    });
    const stdout = (child as unknown as { stdout: PassThrough }).stdout;
    const stderr = (child as unknown as { stderr: PassThrough }).stderr;

    const result = await new KimiAcpAdapter().run(baseRequest() as never);
    expect(result.status).toBe('completed');

    // 这就是修复建立的不变量：日志流关闭前，喂它数据的那两个监听器必须已经摘掉。
    // 留着监听器 = 子进程缓冲数据会在流 end 之后继续写进来 = ERR_STREAM_WRITE_AFTER_END。
    expect(stdout.listenerCount('data')).toBe(0);
    expect(stderr.listenerCount('data')).toBe(0);

    // 于是 late data 变成无人接收的字节，写多少都不会碰到已关闭的流。
    for (let i = 0; i < 20; i += 1) {
      stdout.write(`late-${i}\n`);
      stderr.write(`late-err-${i}\n`);
    }
    await new Promise((r) => setTimeout(r, 50));
  });

  it('先等子进程 close 再收日志流，不是 kill 完就收', async () => {
    const child = installFakeAgent({
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } }],
    });
    await new KimiAcpAdapter().run(baseRequest() as never);
    // 假子进程的 kill 会把 exitCode 落定；跑完必须是已退出状态，
    // 说明适配器确实等到了进程收干净，而不是发完信号就走。
    expect((child as unknown as { exitCode: number | null }).exitCode).toBe(0);
    expect((child as unknown as { kill: { mock: { calls: unknown[] } } }).kill.mock.calls.length).toBeGreaterThan(0);
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

    // 🔴 回放的历史一条都不能进本轮正文——用户说过的话不能变成助手输出，
    // **上一轮的助手正文更不能被当成本轮内容再吐一遍**（真机实付：续接后回答变成
    // 「旧答案+新答案」，用户看到的是每轮复读）。
    const deltas = events
      .filter((e) => e.type === 'message_delta')
      .map((e) => e.data as { path: string; text: string });
    const contentText = deltas.filter((d) => d.path === 'content').map((d) => d.text).join('');
    const reasoningText = deltas.filter((d) => d.path === 'reasoning').map((d) => d.text).join('');
    expect(contentText).toBe('续上了');
    expect(contentText).not.toContain('上一轮');
    expect(reasoningText).not.toContain('上一轮');
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

describe('AcpClientAdapter — Neo 的模型选择必须真落到 ACP 会话上', () => {
  const MODEL_OPTION = {
    id: 'model',
    category: 'model',
    currentValue: 'kimi-code/k3',
    options: [{ value: 'kimi-code/k3' }, { value: 'kimi-code/kimi-for-coding' }],
  };

  it('选了 agent 提供的其他模型时，会话上真发出 session/set_config_option', async () => {
    const configSets: Array<Record<string, unknown>> = [];
    installFakeAgent({
      configOptions: [MODEL_OPTION],
      configSets,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });

    await new KimiAcpAdapter().run(baseRequest({ model: 'kimi-code/kimi-for-coding' }) as never);

    expect(configSets).toEqual([
      { sessionId: 'sess-fake-1', configId: 'model', value: 'kimi-code/kimi-for-coding' },
    ]);
  });

  it('已经是当前值就不多发一次请求', async () => {
    const configSets: Array<Record<string, unknown>> = [];
    installFakeAgent({
      configOptions: [MODEL_OPTION],
      configSets,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });
    await new KimiAcpAdapter().run(baseRequest({ model: 'kimi-code/k3' }) as never);
    expect(configSets).toEqual([]);
  });

  /**
   * 🔴 这条挡的是「装好没接电」的另一半：agent 不提供该模型时，绝不能静默跑
   * agent 默认模型当成功——必须留一条可查的台账，否则用户在 UI 上选的模型是装饰品。
   */
  it('agent 不提供该模型时不发请求，并把降级原因落进台账', async () => {
    const configSets: Array<Record<string, unknown>> = [];
    installFakeAgent({
      configOptions: [MODEL_OPTION],
      configSets,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });

    await new KimiAcpAdapter().run(baseRequest({ model: 'gpt-9' }) as never);

    expect(configSets).toEqual([]);
    const messages = mocks.appendEvent.mock.calls.map((call) => String((call[0] as { message?: string }).message ?? ''));
    expect(messages.some((m) => m.includes('model not applied') && m.includes('does not offer gpt-9'))).toBe(true);
  });

  it('按 category 定位而不是按 id 猜（各家 id 自取，category 才是协议位）', async () => {
    const configSets: Array<Record<string, unknown>> = [];
    installFakeAgent({
      configOptions: [{ ...MODEL_OPTION, id: 'vendor_specific_id' }],
      configSets,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });
    await new KimiAcpAdapter().run(baseRequest({ model: 'kimi-code/kimi-for-coding' }) as never);
    expect(configSets[0]?.configId).toBe('vendor_specific_id');
  });

  it('agent 完全没有 model 配置项时也留痕', async () => {
    const configSets: Array<Record<string, unknown>> = [];
    installFakeAgent({
      configOptions: [{ id: 'thinking', category: 'thought_level' }],
      configSets,
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } }],
    });
    await new KimiAcpAdapter().run(baseRequest({ model: 'kimi-code/k3' }) as never);
    expect(configSets).toEqual([]);
    const messages = mocks.appendEvent.mock.calls.map((call) => String((call[0] as { message?: string }).message ?? ''));
    expect(messages.some((m) => m.includes('no model config option'))).toBe(true);
  });
});


describe('AcpClientAdapter — 用户看到的失败卡', () => {
  /**
   * 🔴 2026-08-27 爸真机截图：聊天区红卡写着「Kimi Code (ACP) 运行失败 / ACP connection closed」。
   * 那句是 SDK 在连接带着在飞请求关闭时抛的内部字符串，对使用者零信息量。
   */
  it('把 SDK 内部话术翻成人话，原文只留在结构化诊断里', async () => {
    const child = installFakeAgent({ updates: [], hangPrompt: true });
    // session/prompt 永不作答，再掐断连接 —— 复现 SDK 抛 "ACP connection closed"
    const stdout = (child as unknown as { stdout: PassThrough }).stdout;
    setTimeout(() => stdout.end(), 80);

    const result = await new KimiAcpAdapter().run(baseRequest() as never);

    expect(result.status).toBe('failed');
    expect(events.some((event) => event.type === 'error')).toBe(false);
    const assistantMessage = mocks.addMessageToSession.mock.calls
      .map((call) => call[1])
      .find((message) => message?.role === 'assistant');
    expect(assistantMessage?.metadata?.agentError?.rawMessage).toContain('连接');
    expect(assistantMessage?.metadata?.agentError?.rawMessage).not.toMatch(/ACP connection closed/i);
    // 原文不丢：结构化诊断和日志页仍可用于排查。
    expect(result.failure?.message ?? '').toMatch(/closed/i);
  });

  it('用户中断这一轮时报 cancelled，不画成红色失败卡', async () => {
    const child = installFakeAgent({ updates: [], hangPrompt: true });
    const stdout = (child as unknown as { stdout: PassThrough }).stdout;
    const controller = new AbortController();
    setTimeout(() => { controller.abort(); stdout.end(); }, 80);

    const result = await new KimiAcpAdapter().run(
      baseRequest({ abortSignal: controller.signal }) as never,
    );

    expect(result.status).toBe('cancelled');
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.map((e) => e.type).slice(-3)).toEqual(['message', 'turn_end', 'agent_complete']);
  });
});
