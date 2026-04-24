// ============================================================================
// Live Preview IPC Handlers - domain:livePreview
// ----------------------------------------------------------------------------
// 只处理 renderer 需要主进程配合的动作（URL 校验、项目根目录解析、未来的
// visual_edit orchestration）。点击 → 源码坐标的核心闭环走 postMessage，
// 不经主进程。
// ============================================================================

import path from 'node:path';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';

interface ResolveSourceLocationRequest {
  file: string;
  projectRoot?: string;
}

interface ResolveSourceLocationResponse {
  absolute: string;
  relative: string;
  exists: boolean;
}

/**
 * 把 bridge 回传的路径（相对或绝对）统一成绝对路径，并校验落在 projectRoot 之内（防路径逃逸）
 */
function resolveSourceLocation(
  req: ResolveSourceLocationRequest,
): ResolveSourceLocationResponse {
  const root = req.projectRoot ? path.resolve(req.projectRoot) : process.cwd();
  const absolute = path.isAbsolute(req.file) ? path.resolve(req.file) : path.resolve(root, req.file);

  // 防路径逃逸：解析后的绝对路径必须以 projectRoot 开头
  const inside = absolute === root || absolute.startsWith(root + path.sep);
  if (!inside) {
    throw new Error(`路径逃逸: ${req.file} 不在 ${root} 内`);
  }

  // 同步存在性检查（文件小，IO 开销低）
  let exists = false;
  try {
    const fs = require('node:fs') as typeof import('node:fs');
    exists = fs.existsSync(absolute);
  } catch {
    /* swallow */
  }

  return {
    absolute,
    relative: path.relative(root, absolute).split(path.sep).join('/'),
    exists,
  };
}

/**
 * 校验一个 URL 是否是可接受的 dev server 地址
 */
function validateDevServerUrl(rawUrl: string): { ok: true; url: string } | { ok: false; reason: string } {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅支持 http(s) 协议' };
    // 只允许本地地址（MVP 阶段）
    const host = u.hostname;
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '0.0.0.0' ||
      host.endsWith('.local') ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      host.startsWith('172.');
    if (!isLocal) return { ok: false, reason: 'MVP 仅支持本地 dev server（localhost/127.x/内网）' };
    return { ok: true, url: u.toString() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export function registerLivePreviewHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.LIVE_PREVIEW, (_event, req: IPCRequest): IPCResponse => {
    try {
      switch (req.action) {
        case 'ping':
          return { success: true, data: { pong: true, version: '0.1.0' } };

        case 'validateDevServerUrl': {
          const payload = req.payload as { url?: string };
          if (!payload?.url) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'url is required' } };
          }
          const result = validateDevServerUrl(payload.url);
          if (!result.ok) {
            return { success: false, error: { code: 'INVALID_URL', message: result.reason } };
          }
          return { success: true, data: { url: result.url } };
        }

        case 'resolveSourceLocation': {
          const payload = req.payload as ResolveSourceLocationRequest;
          if (!payload?.file) {
            return { success: false, error: { code: 'INVALID_ARGS', message: 'file is required' } };
          }
          const data = resolveSourceLocation(payload);
          return { success: true, data };
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `未知 action: ${req.action}` },
          };
      }
    } catch (err) {
      return {
        success: false,
        error: {
          code: 'LIVE_PREVIEW_ERROR',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });
}
