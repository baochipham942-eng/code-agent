// V2-A devServerManager IPC handler smoke test
// 用法：npx tsx scripts/devServerManagerIpc-smoke.mts
// 验证：直接调 livePreview.ipc.ts 的 handler，覆盖 detect/start/wait/stop/logs
//      不依赖 webServer 起来，直接 mock IpcMain 注入。

import { registerLivePreviewHandlers } from '../src/main/ipc/livePreview.ipc';
import { IPC_DOMAINS } from '../src/shared/ipc';
import type { IPCRequest, IPCResponse } from '../src/shared/ipc';

const SPIKE_APP = '/Users/linchen/Downloads/ai/visual-grounding-eval/spike-app';

let registered: ((event: unknown, req: IPCRequest) => Promise<IPCResponse> | IPCResponse) | null = null;

const fakeIpcMain = {
  handle(channel: string, handler: (event: unknown, req: IPCRequest) => Promise<IPCResponse> | IPCResponse) {
    if (channel === IPC_DOMAINS.LIVE_PREVIEW) {
      registered = handler;
    }
  },
  on() {},
  off() {},
  removeAllListeners() {},
} as unknown as Parameters<typeof registerLivePreviewHandlers>[0];

async function call(action: string, payload: unknown = {}): Promise<IPCResponse> {
  if (!registered) throw new Error('handler not registered');
  return Promise.resolve(registered({}, { action, payload } as IPCRequest));
}

function mustOk<T>(res: IPCResponse, label: string): T {
  if (!res.success) {
    console.error(`FAIL [${label}]:`, res.error);
    process.exit(1);
  }
  return res.data as T;
}

async function main() {
  registerLivePreviewHandlers(fakeIpcMain);
  if (!registered) {
    console.error('FAIL: handler not registered');
    process.exit(1);
  }

  // [1] ping
  const ping = mustOk<{ pong: boolean; version: string }>(await call('ping'), 'ping');
  console.log('[1] ping →', ping);

  // [2] detect
  const det = mustOk<{ framework: string; supported: boolean }>(
    await call('detectFramework', { path: SPIKE_APP }),
    'detectFramework',
  );
  console.log('[2] detect →', det);
  if (det.framework !== 'vite' || !det.supported) {
    console.error('FAIL: 期望 vite + supported');
    process.exit(1);
  }

  // [3] start + wait + getSession
  const session = mustOk<{ sessionId: string; status: string }>(
    await call('startDevServer', { path: SPIKE_APP }),
    'startDevServer',
  );
  console.log('[3] start →', session.sessionId, session.status);

  const ready = mustOk<{ url: string }>(
    await call('waitDevServerReady', { sessionId: session.sessionId }),
    'waitDevServerReady',
  );
  console.log('  ready →', ready.url);

  const after = mustOk<{ status: string; url: string | null } | null>(
    await call('getDevServerSession', { sessionId: session.sessionId }),
    'getDevServerSession',
  );
  console.log('  session post-ready →', after);

  // [4] logs
  const logs = mustOk<Array<{ stream: string; line: string }>>(
    await call('getDevServerLogs', { sessionId: session.sessionId }),
    'getDevServerLogs',
  );
  console.log('[4] logs len:', logs.length, 'first:', logs[0]?.line.slice(0, 60));
  if (logs.length === 0) {
    console.error('FAIL: 期望 logs 非空');
    process.exit(1);
  }

  // [5] list
  const list = mustOk<Array<{ sessionId: string }>>(await call('listDevServers'), 'listDevServers');
  console.log('[5] list →', list.length, '条');

  // [6] stop
  mustOk(await call('stopDevServer', { sessionId: session.sessionId }), 'stopDevServer');
  const post = mustOk<unknown>(await call('getDevServerSession', { sessionId: session.sessionId }), 'getSession');
  console.log('[6] stopped, session now:', post);
  const listAfter = mustOk<Array<unknown>>(await call('listDevServers'), 'listDevServers');
  if (listAfter.length !== 0) {
    console.error('FAIL: stop 后 list 非空');
    process.exit(1);
  }

  // [7] 错误路径：不存在的 session
  const bad = await call('waitDevServerReady', { sessionId: 'fake-id-zzz' });
  console.log('[7] 不存在 session →', bad.success ? 'WRONG' : bad.error?.code);
  if (bad.success) {
    console.error('FAIL: 期望失败');
    process.exit(1);
  }

  // [8] 错误路径：缺 path
  const bad2 = await call('detectFramework', {});
  console.log('[8] 缺 path →', bad2.success ? 'WRONG' : bad2.error?.message);
  if (bad2.success) {
    console.error('FAIL: 期望失败');
    process.exit(1);
  }

  console.log('\n✓ IPC handler smoke 全过');
  process.exit(0);
}

main().catch((err) => {
  console.error('UNCAUGHT:', err);
  process.exit(1);
});
