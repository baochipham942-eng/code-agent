// ============================================================================
// Terminal IPC Handlers - domain:terminal
// ----------------------------------------------------------------------------
// 右栏终端视图的宿主侧入口。PTY 输出走 broadcastToRenderer(TERMINAL_OUTPUT) 推送，
// 不做轮询；重新挂载时用 open 返回的 snapshot 一次性补齐历史画面。
// ============================================================================

import type { IpcMain } from '../platform';
import { broadcastToRenderer } from '../platform/windowBridge';
import { IPC_CHANNELS, IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getHomeDir } from '../config/configPaths';
import {
  disposeTerminalSession,
  getTerminalSnapshot,
  listTerminalSessions,
  onTerminalOutput,
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

export function registerTerminalHandlers(ipcMain: IpcMain): void {
  if (!outputBridgeAttached) {
    onTerminalOutput((sessionId, data) => {
      broadcastToRenderer(IPC_CHANNELS.TERMINAL_OUTPUT, { sessionId, data });
    });
    outputBridgeAttached = true;
    // 上次进程被强杀留下的孤儿 PTY 在这里收割——注册期只跑一次。
    reapOrphanTerminals();
  }

  ipcMain.handle(IPC_DOMAINS.TERMINAL, async (_event, req: IPCRequest): Promise<IPCResponse> => {
    try {
      const sessionId = readString(req.payload, 'sessionId');
      switch (req.action) {
        case 'open': {
          if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
          // 没设工作目录时落到家目录，不是 process.cwd()——打包态由 launchd 拉起，
          // cwd 是 `/`，终端一开就停在根目录上。
          const cwd = readString(req.payload, 'cwd') || getHomeDir();
          const snapshot = openTerminalSession({
            sessionId,
            cwd,
            cols: readNumber(req.payload, 'cols'),
            rows: readNumber(req.payload, 'rows'),
          });
          return { success: true, data: snapshot };
        }
        case 'write': {
          if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
          const data = readString(req.payload, 'data');
          if (data === undefined) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 data' } };
          const result = writeToTerminalSession(sessionId, data);
          return result.ok
            ? { success: true, data: { written: true } }
            : { success: false, error: { code: 'WRITE_FAILED', message: result.error ?? 'write failed' } };
        }
        case 'resize': {
          if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
          const cols = readNumber(req.payload, 'cols');
          const rows = readNumber(req.payload, 'rows');
          if (!cols || !rows) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 cols/rows' } };
          return { success: true, data: { resized: resizeTerminalSession(sessionId, cols, rows) } };
        }
        case 'close': {
          if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
          return { success: true, data: { closed: disposeTerminalSession(sessionId) } };
        }
        case 'snapshot': {
          if (!sessionId) return { success: false, error: { code: 'INVALID_ARGS', message: '缺少 sessionId' } };
          return { success: true, data: getTerminalSnapshot(sessionId) };
        }
        case 'list':
          return { success: true, data: listTerminalSessions() };
        default:
          return { success: false, error: { code: 'UNKNOWN_ACTION', message: `未知 action: ${req.action}` } };
      }
    } catch (err) {
      return {
        success: false,
        error: { code: 'TERMINAL_ERROR', message: err instanceof Error ? err.message : String(err) },
      };
    }
  });
}
