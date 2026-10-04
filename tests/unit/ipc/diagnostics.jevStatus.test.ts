import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 diagnostics jevStatus 出口（N-JEV-DEFAULT-ON）：返回四特性开关/生效/降级计数
// 快照，route 只给类别不给 key。provider mock —— 测试不触网、不读 SecureStorage。
const providerState = vi.hoisted(() => ({
  route: null as null | { kind: 'official' | 'openrouter' },
}));

vi.mock('../../../src/host/model/providers/typesafeProvider', () => ({
  resolveJevRoute: () => providerState.route,
  systemOne: vi.fn(),
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

type DiagnosticsHandler = (e: unknown, req: IPCRequest) => Promise<IPCResponse>;

function captureHandler(): DiagnosticsHandler {
  const handlers = new Map<string, DiagnosticsHandler>();
  const fakeIpcMain = {
    handle: (domain: string, fn: DiagnosticsHandler) => {
      handlers.set(domain, fn);
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  const handler = handlers.get(IPC_DOMAINS.DIAGNOSTICS);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

const call = (): Promise<IPCResponse> =>
  captureHandler()(null, { action: 'jevStatus', payload: {} } as IPCRequest);

beforeEach(() => {
  providerState.route = null;
});

describe('diagnostics jevStatus', () => {
  it('返回状态形状：四特性 flagOn/effective/degradedCount + route 类别', async () => {
    const res = await call();
    expect(res.success).toBe(true);
    const data = res.data as {
      keyConfigured: boolean;
      route: string | null;
      features: Record<string, { flagOn: boolean; effective: boolean; degradedCount: number }>;
    };
    expect(data.keyConfigured).toBe(false);
    expect(data.route).toBe(null);
    expect(Object.keys(data.features).sort()).toEqual(
      ['compaction', 'injectionScan', 'permissionClassifier', 'router'],
    );
    for (const feature of Object.keys(data.features)) {
      expect(data.features[feature].flagOn, feature).toBe(true);
      expect(data.features[feature].effective, feature).toBe(false);
      expect(Number.isInteger(data.features[feature].degradedCount), feature).toBe(true);
    }
  });

  it("有 key 时 keyConfigured=true、route='official'，且响应永不包含 key 材料", async () => {
    providerState.route = { kind: 'official' };
    const res = await call();
    expect(res.success).toBe(true);
    const serialized = JSON.stringify(res.data);
    expect(serialized).toContain('"keyConfigured":true');
    expect(serialized).toContain('"route":"official"');
    expect(serialized).not.toMatch(/apiKey|api_key|sk-|secret/i);
  });
});
