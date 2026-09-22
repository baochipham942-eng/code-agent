// ============================================================================
// Terminal IPC Handlers - domain:terminal
// ----------------------------------------------------------------------------
// 右栏终端视图的宿主侧入口。PTY 输出走 broadcastToRenderer(TERMINAL_OUTPUT) 推送，
// 不做轮询；重新挂载时用 open 返回的 snapshot 一次性补齐历史画面。
// ============================================================================

import type { IpcMain } from '../platform';
import { broadcastToRenderer } from '../platform/windowBridge';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { TerminalSchemas, type TerminalDomainRequest } from '../../shared/ipc/schemas/terminal';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getHomeDir } from '../config/configPaths';
import {
  disposeTerminalSession,
  getTerminalSnapshot,
  listTerminalSessions,
  onTerminalOutput,
  onTerminalReveal,
  openTerminalSession,
  reapOrphanTerminals,
  resizeTerminalSession,
  writeToTerminalSession,
} from '../services/terminal/terminalSessionManager';

function readString(payload: unknown, key: string): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(payload: unknown, key: string): number | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

let outputBridgeAttached = false;

/**
 * terminal 域单源路由表（RQ-183 续作·TERMINAL 刀）：原 domain switch 6 个 case 平移为 handler（rawResponse：INVALID_ARGS /
 * WRITE_FAILED 业务失败原样直返）。sessionId 原在 try 内分发前统一读，现由用到它的 handler 各自读（readString 纯函数，差异不可观测）。
 * 未知 action → UNKNOWN_ACTION + `未知 action:`（unknownActionCode / unknownActionMessage 保持原中文文案）；抛错 code 固定
 * TERMINAL_ERROR（resolveErrorCode），message 由装配器取 Error.message / String(error)，与原 catch 一致。
 * 请求体为 null / 非对象时原实现在 try 内读 req.payload 抛错落 TERMINAL_ERROR，现返回 UNKNOWN_ACTION。
 */
const terminalHandlers: RawDomainRouteHandlers<TerminalDomainRequest, void> = {
  open: async (_ctx, payload) => {
    const sessionId = readString(payload, 'sessionId');
    if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
    // 没设工作目录时落到家目录，不是 process.cwd()——打包态由 launchd 拉起，
    // cwd 是 `/`，终端一开就停在根目录上。
    const cwd = readString(payload, 'cwd') || getHomeDir();
    const snapshot = openTerminalSession({
      sessionId,
      cwd,
      cols: readNumber(payload, 'cols'),
      rows: readNumber(payload, 'rows'),
    });
    return { success: true, data: snapshot };
  },
  write: async (_ctx, payload) => {
    const sessionId = readString(payload, 'sessionId');
    if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
    const data = readString(payload, 'data');
    if (data === undefined) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 data' } };
    const result = writeToTerminalSession(sessionId, data);
    return result.ok
      ? { success: true, data: { written: true } }
      : { success: false, error: { code: 'WRITE_FAILED', message: result.error ?? 'write failed' } };
  },
  resize: async (_ctx, payload) => {
    const sessionId = readString(payload, 'sessionId');
    if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
    const cols = readNumber(payload, 'cols');
    const rows = readNumber(payload, 'rows');
    if (!cols || !rows) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 cols/rows' } };
    return { success: true, data: { resized: resizeTerminalSession(sessionId, cols, rows) } };
  },
  close: async (_ctx, payload) => {
    const sessionId = readString(payload, 'sessionId');
    if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
    return { success: true, data: { closed: await disposeTerminalSession(sessionId) } };
  },
  snapshot: async (_ctx, payload) => {
    const sessionId = readString(payload, 'sessionId');
    if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
    return { success: true, data: getTerminalSnapshot(sessionId) };
  },
  list: async () => ({ success: true, data: listTerminalSessions() }),
};

const terminalRoutes = defineDomainRoutes<TerminalDomainRequest, void>(TerminalSchemas.REQUEST, terminalHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `未知 action: ${String(action)}`,
  resolveErrorCode: () => 'TERMINAL_ERROR',
});

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  if (!outputBridgeAttached) {
    onTerminalOutput((sessionId, data) => {
      broadcastToRenderer(IPC_CHANNELS.TERMINAL_OUTPUT, { sessionId, data });
    });
    onTerminalReveal((sessionId) => {
      broadcastToRenderer(IPC_CHANNELS.TERMINAL_REVEAL, { sessionId });
    });
    outputBridgeAttached = true;
    // 上次进程被强杀留下的孤儿 PTY 在这里收割——注册期只跑一次。
    reapOrphanTerminals();
  }

  installDomainRoutes(ipcMain, terminalRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerTerminalHandlers.routes = terminalRoutes;
