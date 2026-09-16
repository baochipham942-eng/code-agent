// ============================================================================
// Soul IPC Handlers
// ============================================================================

import { ipcHost } from '../platform';
import { SoulSchemas, type SoulDomainRequest } from '../../shared/ipc/schemas/soul';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { loadSoul, getSoul } from '../prompts/soulLoader';
import { IDENTITY } from '../prompts/identity';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SoulIPC');

function getStringField(source: unknown, field: string): string | undefined {
  if (!source || typeof source !== 'object' || Array.isArray(source)) return undefined;
  const value = (source as Record<string, unknown>)[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * soul 域单源路由表（RQ-183 续作·SOUL 刀）：原 domain switch 5 个大括号 case 平移为默认模式 handler（case 体原样，末尾
 * `return { success: true, data: X } satisfies IPCResponse` 改为 `return X`，装配器包 { success: true, data }）。未知 action →
 * UNKNOWN_ACTION + `Unknown soul action:`（unknownActionCode / unknownActionMessage 保持原契约）；抛错进 mapError：原样记
 * `Soul IPC error:` 日志 + SOUL_ERROR（Error.message，非 Error 为 'Unknown error'）。
 * 请求体为 null / 非对象时原实现在 try 外解构抛错（IPC reject），现返回 UNKNOWN_ACTION。
 */
const soulRoutes = defineDomainRoutes<SoulDomainRequest, void>(SoulSchemas.REQUEST, {
  getStatus: (_ctx, payload) => {
    const soul = getSoul();
    const workingDirectory = getStringField(payload, 'workingDirectory');
    let source: 'project' | 'user' | 'builtin' = 'builtin';
    if (workingDirectory) {
      const profilePath = path.join(getProjectConfigDir(workingDirectory), 'PROFILE.md');
      if (fs.existsSync(profilePath)) source = 'project';
    }
    if (source === 'builtin') {
      const soulPath = path.join(getUserConfigDir(), 'SOUL.md');
      if (fs.existsSync(soulPath)) source = 'user';
    }
    return { source, length: soul.length };
  },
  getProfile: (_ctx, payload) => {
    const { scope, workingDirectory: wd } = (payload || {}) as { scope: 'project' | 'user'; workingDirectory?: string };
    let filePath: string;
    if (scope === 'project' && wd) {
      filePath = path.join(getProjectConfigDir(wd), 'PROFILE.md');
    } else {
      filePath = path.join(getUserConfigDir(), 'SOUL.md');
    }
    const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf-8') : '';
    return { content, filePath };
  },
  saveProfile: (_ctx, payload) => {
    const { scope, content, workingDirectory: wd } = (payload || {}) as { scope: 'project' | 'user'; content: string; workingDirectory?: string };
    let filePath: string;
    if (scope === 'project' && wd) {
      const dir = getProjectConfigDir(wd);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, 'PROFILE.md');
    } else {
      const dir = getUserConfigDir();
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      filePath = path.join(dir, 'SOUL.md');
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    loadSoul(wd);
    return { filePath };
  },
  getDefault: (_ctx, _payload) => {
    // 返回内置身份核心块（不含安全红线/工程层，那些始终保留不可编辑）
    // 供设置页在用户尚未自定义时预填编辑器，作为安全的起改基线。
    return { content: String(IDENTITY) };
  },
  resetProfile: (_ctx, payload) => {
    // 删除自定义人格文件，干净恢复内置默认（比写空内容更彻底，避免 getStatus 仍报 user）
    const { scope, workingDirectory: wd } = (payload || {}) as { scope: 'project' | 'user'; workingDirectory?: string };
    let filePath: string;
    if (scope === 'project' && wd) {
      filePath = path.join(getProjectConfigDir(wd), 'PROFILE.md');
    } else {
      filePath = path.join(getUserConfigDir(), 'SOUL.md');
    }
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    loadSoul(wd);
    return { filePath };
  },
}, {
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown soul action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Soul IPC error:', error);
    return { code: 'SOUL_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerSoulHandlers(): void {
  installDomainRoutes(ipcHost, soulRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerLoopHandlers.routes 先例）
registerSoulHandlers.routes = soulRoutes;
