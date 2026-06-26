import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IPCRequest, IPCResponse } from '../../../src/shared/ipc';

// 验证 logClientError 出口：把 renderer 侧错误（如更新安装失败）落进后端文件 logger（code-agent-*.log），
// 修复"renderer 错误只走 console、正式包 devtools 关、失败无据可查"的可观测性缺口。
const logState = vi.hoisted(() => ({
  calls: [] as Array<{ context: string; message: string; args: unknown[] }>,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: (context: string) => ({
    error: (message: string, ...args: unknown[]) => {
      logState.calls.push({ context, message, args });
    },
  }),
}));

import { registerDiagnosticsHandlers } from '../../../src/host/ipc/diagnostics.ipc';
import { IPC_DOMAINS } from '../../../src/shared/ipc';

function captureHandler() {
  let handler: ((e: unknown, req: IPCRequest) => Promise<IPCResponse>) | null = null;
  const fakeIpcMain = {
    handle: (domain: string, fn: (e: unknown, req: IPCRequest) => Promise<IPCResponse>) => {
      if (domain === IPC_DOMAINS.DIAGNOSTICS) handler = fn;
    },
  };
  registerDiagnosticsHandlers(fakeIpcMain as never);
  if (!handler) throw new Error('diagnostics handler not registered');
  return handler;
}

const call = (payload: unknown): Promise<IPCResponse> =>
  captureHandler()(null, { action: 'logClientError', payload } as IPCRequest);

beforeEach(() => {
  logState.calls = [];
});

describe('diagnostics logClientError', () => {
  it('把 renderer 错误写进后端 file logger（含 context/message/detail）', async () => {
    const res = await call({
      context: 'UpdateInstall',
      message: 'Tauri update install failed',
      detail: 'Error: download interrupted\n  at x',
    });
    expect(res.success).toBe(true);
    expect(logState.calls).toHaveLength(1);
    expect(logState.calls[0].context).toBe('UpdateInstall');
    expect(logState.calls[0].message).toBe('Tauri update install failed');
    // detail 作为附加参数传给 logger.error（writeToFile 会落盘）
    expect(JSON.stringify(logState.calls[0].args)).toContain('download interrupted');
  });

  it('缺 message 时拒绝且不写日志（防空噪音）', async () => {
    const res = await call({ context: 'UpdateInstall', message: '   ' });
    expect(res.success).toBe(false);
    expect(logState.calls).toHaveLength(0);
  });

  it('缺 context 时回退到默认 context，仍落盘', async () => {
    const res = await call({ message: '更新检查失败' });
    expect(res.success).toBe(true);
    expect(logState.calls).toHaveLength(1);
    expect(logState.calls[0].context).toBeTruthy();
  });
});
