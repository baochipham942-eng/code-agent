// ============================================================================
// Live Preview IPC Handlers - domain:livePreview
// ----------------------------------------------------------------------------
// 只处理 renderer 需要主进程配合的动作（URL 校验、项目根目录解析、未来的
// visual_edit orchestration）。点击 → 源码坐标的核心闭环走 postMessage，
// 不经主进程。
// ============================================================================

import path from 'node:path';
import type { IpcMain } from '../platform';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { LivePreviewSchemas, type LivePreviewDomainRequest } from '../../shared/ipc/schemas/livePreview';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getDevServerManager } from '../services/infra/devServerManager';
import { applyTweak } from '../tools/livePreview/tweakWriter';
import type { ClassMutation, TweakLocation } from '../../shared/livePreview/tweak';

interface ResolveSourceLocationRequest {
  file: string;
  projectRoot?: string;
  /** V2-A：dev server session 的 projectPath 是 baseDir 的优先源
   *  （bridge 回传 relative path 是相对 vite 项目根，不是 code-agent cwd 也不是 user workspace） */
  devServerSessionId?: string;
}

interface ResolveSourceLocationResponse {
  absolute: string;
  relative: string;
  exists: boolean;
}

/**
 * 把 bridge 回传的路径（相对或绝对）统一成绝对路径，并校验落在 projectRoot 之内（防路径逃逸）
 *
 * baseDir 优先级：
 *   1. devServerSessionId → manager.get(sessionId).projectPath（V2-A 自动起的 dev server，最准）
 *   2. 显式 projectRoot 参数（用户在 TitleBar 设的 working directory）
 *   3. process.cwd()（兜底，通常是 code-agent 自己，bridge 路径肯定不存在）
 */
export function resolveLivePreviewSourceLocation(
  req: ResolveSourceLocationRequest,
): ResolveSourceLocationResponse {
  let baseDir: string;
  if (req.devServerSessionId) {
    const session = getDevServerManager().get(req.devServerSessionId);
    baseDir = session?.projectPath || req.projectRoot || process.cwd();
  } else {
    baseDir = req.projectRoot || process.cwd();
  }
  const root = path.resolve(baseDir);
  const absolute = path.isAbsolute(req.file) ? path.resolve(req.file) : path.resolve(root, req.file);

  // 防路径逃逸：解析后的绝对路径必须以 projectRoot 开头
  const relative = path.relative(root, absolute);
  const inside = relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
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
    relative: relative.split(path.sep).join('/'),
    exists,
  };
}

/**
 * 校验一个 URL 是否是可接受的 dev server 地址
 */
export function validateLivePreviewDevServerUrl(rawUrl: string): { ok: true; url: string } | { ok: false; reason: string } {
  try {
    const u = new URL(rawUrl);
    if (!/^https?:$/.test(u.protocol)) return { ok: false, reason: '仅支持 http(s) 协议' };
    // 只允许当前 renderer CSP frame-src 真能加载的本机 dev server。
    const host = u.hostname;
    const isAllowedFrameHost = host === 'localhost' || host === '127.0.0.1';
    if (!isAllowedFrameHost) return { ok: false, reason: 'Live Preview 仅支持 localhost / 127.0.0.1 dev server' };
    return { ok: true, url: u.toString() };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

function requireProjectPath(payload: unknown): string {
  const path = (payload as { path?: string } | null)?.path;
  if (!path || typeof path !== 'string' || !path.trim()) {
    throw new Error('path is required');
  }
  return path.trim();
}

function requireSessionId(payload: unknown): string {
  const sid = (payload as { sessionId?: string } | null)?.sessionId;
  if (!sid || typeof sid !== 'string') {
    throw new Error('sessionId is required');
  }
  return sid;
}

/**
 * livePreview 域单源路由表（RQ-183 续作·LIVE_PREVIEW 刀）：原 domain switch 11 个 case 逐 case 平移为 handler（rawResponse：
 * INVALID_ARGS / INVALID_URL 业务失败原样直返；case 间分组注释随下一个 handler 保留）。`req.payload` → 参数 `requestPayload`
 *（validateDevServerUrl / resolveSourceLocation / applyTweak 体内自有 `const payload`）。未知 action → UNKNOWN_ACTION + `未知 action:`
 *（unknownActionCode / unknownActionMessage 保持原中文文案）；抛错 code 固定 LIVE_PREVIEW_ERROR（resolveErrorCode），message 由装配器取
 * Error.message / String(error)，与原 catch 一致。请求体为 null / 非对象时原实现在 try 内读 req.action 抛错落 LIVE_PREVIEW_ERROR，
 * 现返回 UNKNOWN_ACTION。
 */
const livePreviewHandlers: RawDomainRouteHandlers<LivePreviewDomainRequest, void> = {
  ping: async (_ctx, _requestPayload) => {
    return { success: true, data: { pong: true, version: '0.2.0' } };
  },
  validateDevServerUrl: async (_ctx, requestPayload) => {
    const payload = requestPayload as { url?: string };
    if (!payload?.url) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'url is required' } };
    }
    const result = validateLivePreviewDevServerUrl(payload.url);
    if (!result.ok) {
      return { success: false, error: { code: 'INVALID_URL', message: result.reason } };
    }
    return { success: true, data: { url: result.url } };
  },
  resolveSourceLocation: async (_ctx, requestPayload) => {
    const payload = requestPayload as ResolveSourceLocationRequest;
    if (!payload?.file) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'file is required' } };
    }
    const data = resolveLivePreviewSourceLocation(payload);
    return { success: true, data };
  },
  // --------------------------------------------------------------------
  // V2-A devServerManager
  // --------------------------------------------------------------------
  detectFramework: async (_ctx, requestPayload) => {
    const projectPath = requireProjectPath(requestPayload);
    const data = getDevServerManager().detect(projectPath);
    return { success: true, data };
  },
  startDevServer: async (_ctx, requestPayload) => {
    const projectPath = requireProjectPath(requestPayload);
    // 同步返回 status='starting' 的 session；renderer 调
    // waitDevServerReady 拿 URL，或用 getDevServerSession 轮询 status
    const session = getDevServerManager().start(projectPath);
    return { success: true, data: session };
  },
  waitDevServerReady: async (_ctx, requestPayload) => {
    const sessionId = requireSessionId(requestPayload);
    const url = await getDevServerManager().waitForReady(sessionId);
    return { success: true, data: { url } };
  },
  stopDevServer: async (_ctx, requestPayload) => {
    const sessionId = requireSessionId(requestPayload);
    await getDevServerManager().stop(sessionId);
    return { success: true, data: { sessionId } };
  },
  getDevServerSession: async (_ctx, requestPayload) => {
    const sessionId = requireSessionId(requestPayload);
    const session = getDevServerManager().get(sessionId);
    return { success: true, data: session };
  },
  getDevServerLogs: async (_ctx, requestPayload) => {
    const sessionId = requireSessionId(requestPayload);
    const logs = getDevServerManager().getLogs(sessionId);
    return { success: true, data: logs };
  },
  listDevServers: async (_ctx, _requestPayload) => {
    const data = getDevServerManager().list();
    return { success: true, data };
  },
  // --------------------------------------------------------------------
  // V2-B Tweak 面板
  // --------------------------------------------------------------------
  applyTweak: async (_ctx, requestPayload) => {
    const payload = requestPayload as { location?: TweakLocation; mutation?: ClassMutation };
    if (!payload?.location || !payload?.mutation) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'location + mutation required' } };
    }
    // 路径必须绝对，避免 cwd 漂移导致改错文件
    if (!path.isAbsolute(payload.location.file)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'file must be absolute' } };
    }
    const data = applyTweak(payload.location, payload.mutation);
    return { success: true, data };
  },
};

const livePreviewRoutes = defineDomainRoutes<LivePreviewDomainRequest, void>(LivePreviewSchemas.REQUEST, livePreviewHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `未知 action: ${String(action)}`,
  resolveErrorCode: () => 'LIVE_PREVIEW_ERROR',
});

export function registerLivePreviewHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, livePreviewRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerLivePreviewHandlers.routes = livePreviewRoutes;
