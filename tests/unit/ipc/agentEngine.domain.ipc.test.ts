import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../../src/shared/ipc';
import { AgentEngineCapabilityError } from '../../../src/shared/contract/agentEngine';

// agentEngine.ipc.ts 派发特征测试（RQ-183 续作·AGENT_ENGINE 刀迁表前钉住 switch 形态）：派发层 9 个 action。
// 既有 agentEngine.ipc.test.ts 只覆盖 detect 的双缓存失效与并发等待。这里补派发层契约：
// - list / listSources / get / listModels / listHistory / previewHistory 的委派与原样回传（payload 透传）
// - select 缺参 INVALID_PAYLOAD；selectModel 的 INVALID_PAYLOAD / SESSION_NOT_FOUND / INVALID_ENGINE / MODEL_NOT_FOUND / MODEL_DISABLED 完整文案
// - catch 映射：AgentEngineCapabilityError → 自带 code + details{engine,capability}；AgentEngineModelIncompatibleError →
//   MODEL_NOT_FOUND + details{engine,model}；AgentEngineHistoryImportError → 自带 code + details；普通 Error → INTERNAL_ERROR；非 Error → String
// - 未知 action → INVALID_ACTION + `Unknown action: <action>` 完整文案
// 迁表后本文件零改动全绿即行为不变证明。错误实例用 Object.create(prototype) 构造，不依赖构造函数签名。

const env = vi.hoisted(() => {
  class AgentEngineModelIncompatibleError extends Error {}
  class AgentEngineHistoryImportError extends Error {}
  return {
    AgentEngineModelIncompatibleError,
    AgentEngineHistoryImportError,
    registry: {
      invalidate: vi.fn(),
      list: vi.fn(async (): Promise<unknown> => [{ kind: 'native' }]),
      listSources: vi.fn(async (): Promise<unknown> => [{ source: 's' }]),
      get: vi.fn(async (_kind: string): Promise<unknown> => ({ kind: 'codex' })),
    },
    catalog: {
      invalidate: vi.fn(),
      readCatalog: vi.fn(async (): Promise<unknown> => ({ catalog: { engines: [] } })),
      resolveModelId: vi.fn(async (): Promise<unknown> => undefined),
    },
    catalogEngine: vi.fn((): unknown => undefined),
    history: {
      listHistory: vi.fn(async (_req: unknown): Promise<unknown> => [{ id: 'h1' }]),
      previewHistory: vi.fn(async (_req: unknown): Promise<unknown> => ({ id: 'h1', turns: [] })),
    },
    session: {
      getSession: vi.fn(async (): Promise<unknown> => null),
      updateSession: vi.fn(async () => {}),
    },
  };
});

vi.mock('../../../src/host/services/agentEngine', () => ({
  getAgentEngineRegistry: () => env.registry,
}));
vi.mock('../../../src/host/services/agentEngine/agentEngineGuards', () => ({
  isExternalAgentEngine: (kind: string) => kind !== 'native',
  buildManualAgentEngineSelection: vi.fn(() => ({ kind: 'codex', updatedAt: 1 })),
}));
vi.mock('../../../src/host/services/agentEngine/agentEngineModelCatalog', () => ({
  AgentEngineModelIncompatibleError: env.AgentEngineModelIncompatibleError,
  getAgentEngineCatalogEngine: () => env.catalogEngine(),
  resolveAgentEngineCatalogModel: vi.fn(),
  getRemoteAgentEngineModelCatalogService: () => env.catalog,
}));
vi.mock('../../../src/host/services/agentEngine/agentEngineHistoryImport', () => ({
  AgentEngineHistoryImportError: env.AgentEngineHistoryImportError,
  getAgentEngineHistoryImportService: () => env.history,
}));
vi.mock('../../../src/host/services/infra/sessionManager', () => ({
  getSessionManager: () => env.session,
}));

import { registerAgentEngineHandlers } from '../../../src/host/ipc/agentEngine.ipc';

type HandlerFn = (event: unknown, request: IPCRequest) => Promise<IPCResponse>;
let call: (action: string, payload?: unknown) => Promise<IPCResponse>;

const fail = (code: string, message: string) => ({ success: false, error: { code, message } });

function errorOf<T extends Error>(cls: abstract new (...args: never[]) => T, fields: Record<string, unknown>): T {
  return Object.assign(Object.create(cls.prototype) as T, fields);
}

beforeEach(() => {
  vi.clearAllMocks();
  env.session.getSession.mockResolvedValue(null);
  env.catalogEngine.mockReturnValue(undefined);
  const handlers = new Map<string, HandlerFn>();
  registerAgentEngineHandlers({ handle: (ch: string, fn: HandlerFn) => handlers.set(ch, fn) } as never);
  const handler = handlers.get(IPC_DOMAINS.AGENT_ENGINE)!;
  call = (action, payload) => handler(null, { action, payload } as IPCRequest);
});

describe('agentEngine.ipc dispatch 特征：只读委派', () => {
  it('list / listSources / get / listModels 原样回传，get 透传 kind', async () => {
    expect(await call('list')).toEqual({ success: true, data: [{ kind: 'native' }] });
    expect(await call('listSources')).toEqual({ success: true, data: [{ source: 's' }] });
    expect(await call('get', { kind: 'kimi' })).toEqual({ success: true, data: { kind: 'codex' } });
    expect(env.registry.get).toHaveBeenCalledWith('kimi');
    expect(await call('listModels')).toEqual({ success: true, data: { catalog: { engines: [] } } });
  });

  it('listHistory / previewHistory 透传 payload 原样回传', async () => {
    const req = { kind: 'codex', limit: 5 };
    expect(await call('listHistory', req)).toEqual({ success: true, data: [{ id: 'h1' }] });
    expect(env.history.listHistory).toHaveBeenCalledWith(req);
    expect(await call('previewHistory', { id: 'h1' })).toEqual({ success: true, data: { id: 'h1', turns: [] } });
    expect(env.history.previewHistory).toHaveBeenCalledWith({ id: 'h1' });
  });
});

describe('agentEngine.ipc dispatch 特征：select / selectModel 业务失败响应', () => {
  it('select 缺 sessionId 或 kind → INVALID_PAYLOAD 完整文案', async () => {
    expect(await call('select', { kind: 'codex' })).toEqual(fail('INVALID_PAYLOAD', 'Agent Engine selection requires sessionId and kind.'));
    expect(await call('select', { sessionId: 's' })).toEqual(fail('INVALID_PAYLOAD', 'Agent Engine selection requires sessionId and kind.'));
  });

  it('selectModel 缺参 / 会话不存在 / 原生引擎', async () => {
    expect(await call('selectModel', { sessionId: 's', model: '  ' }))
      .toEqual(fail('INVALID_PAYLOAD', 'Agent Engine model selection requires sessionId and model.'));
    expect(await call('selectModel', { sessionId: 's', model: 'm' }))
      .toEqual(fail('SESSION_NOT_FOUND', 'Session not found for Agent Engine model selection.'));
    env.session.getSession.mockResolvedValue({ id: 's' });
    expect(await call('selectModel', { sessionId: 's', model: 'm', kind: 'native' }))
      .toEqual(fail('INVALID_ENGINE', 'Native Neo model selection uses the normal model provider settings.'));
  });

  it('selectModel 目录无此模型 → MODEL_NOT_FOUND；模型禁用 → MODEL_DISABLED 带原因', async () => {
    env.session.getSession.mockResolvedValue({ id: 's' });
    expect(await call('selectModel', { sessionId: 's', model: 'm', kind: 'codex' }))
      .toEqual(fail('MODEL_NOT_FOUND', 'Selected Agent Engine model is not present in the signed catalog.'));
    env.catalogEngine.mockReturnValue({ models: [{ id: 'm', disabledReason: 'retired' }] });
    expect(await call('selectModel', { sessionId: 's', model: 'm', kind: 'codex' })).toEqual(fail('MODEL_DISABLED', 'retired'));
    expect(env.session.updateSession).not.toHaveBeenCalled();
  });
});

describe('agentEngine.ipc dispatch 特征：兜底', () => {
  it('未知 action → INVALID_ACTION + 完整文案', async () => {
    expect(await call('bogus')).toEqual(fail('INVALID_ACTION', 'Unknown action: bogus'));
  });

  it('AgentEngineCapabilityError → 自带 code + details{engine,capability}', async () => {
    env.registry.list.mockRejectedValueOnce(errorOf(AgentEngineCapabilityError, {
      code: 'CAPABILITY_UNSUPPORTED', message: 'no fork', engine: 'codex', capability: 'fork',
    }));
    expect(await call('list')).toEqual({
      success: false,
      error: { code: 'CAPABILITY_UNSUPPORTED', message: 'no fork', details: { engine: 'codex', capability: 'fork' } },
    });
  });

  it('AgentEngineModelIncompatibleError → MODEL_NOT_FOUND + details{engine,model}', async () => {
    env.catalog.readCatalog.mockRejectedValueOnce(errorOf(env.AgentEngineModelIncompatibleError, {
      message: 'bad model', kind: 'codex', requestedModel: 'gpt-x',
    }));
    expect(await call('listModels')).toEqual({
      success: false,
      error: { code: 'MODEL_NOT_FOUND', message: 'bad model', details: { engine: 'codex', model: 'gpt-x' } },
    });
  });

  it('AgentEngineHistoryImportError → 自带 code + details 原样', async () => {
    env.history.listHistory.mockRejectedValueOnce(errorOf(env.AgentEngineHistoryImportError, {
      code: 'HISTORY_NOT_FOUND', message: 'gone', details: { path: '/x' },
    }));
    expect(await call('listHistory', {})).toEqual({
      success: false,
      error: { code: 'HISTORY_NOT_FOUND', message: 'gone', details: { path: '/x' } },
    });
  });

  it('普通 Error → INTERNAL_ERROR（无 details 键）；非 Error → String(error)', async () => {
    env.registry.listSources.mockRejectedValueOnce(new Error('sources down'));
    const res = await call('listSources');
    expect(res).toEqual(fail('INTERNAL_ERROR', 'sources down'));
    expect(Object.keys(res.error!)).toEqual(['code', 'message']);
    env.registry.list.mockRejectedValueOnce('raw');
    expect(await call('list')).toEqual(fail('INTERNAL_ERROR', 'raw'));
  });
});
