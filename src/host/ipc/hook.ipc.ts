// ============================================================================
// Hook IPC Handlers - Hook 列表查询 + 配置文件打开
// ============================================================================

import * as path from 'path';
import * as os from 'os';
import { shell } from '../platform';
import type { IpcMain } from '../platform';
import { HookSchemas, type HookDomainRequest } from '../../shared/ipc/schemas/hook';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { CONFIG_DIR_NEW } from '../config/configPaths';
import { loadAllHooksConfig, getHooksConfigPaths, makeHookKey, type HookDefinition } from '../hooks/configParser';
import { mergeHooks, type MergedHookConfig } from '../hooks/merger';
import {
  HOOK_EVENT_DESCRIPTIONS,
  type HookEvent,
} from '../protocol/events';
import { getAdminAccessIpcError } from './adminGuard';

// 所有支持的 event 类型 — 来自 HOOK_EVENT_DESCRIPTIONS 的 keys
const ALL_HOOK_EVENTS: HookEvent[] = Object.keys(HOOK_EVENT_DESCRIPTIONS) as HookEvent[];

interface HookListItem {
  event: HookEvent;
  description: string;
  matcher: string | null;
  type: HookDefinition['type'];
  hint: string;
  sources: Array<'global' | 'project'>;
  hookType: 'decision' | 'observer';
  parallel: boolean;
  /** 停用中：配置还在，但不会执行 */
  disabled: boolean;
  /** 回文件里定位这一条的身份（setEnabled 用） */
  key: string;
}

interface HookSummary {
  enabled: HookListItem[]; // 已经有 hook 注册的 event
  unused: Array<{ event: HookEvent; description: string }>; // 没人监听的 event
  configPaths: {
    global: string;
    project: string | null;
  };
}

function describeHook(hook: HookDefinition): string {
  switch (hook.type) {
    case 'command':
      return hook.command || '(空命令)';
    case 'http':
      return hook.url || '(空 URL)';
    case 'agent':
      return `agent: ${hook.agent || '(未指定)'}`;
    case 'prompt':
      return `prompt: ${(hook.prompt || '').slice(0, 60)}${(hook.prompt || '').length > 60 ? '…' : ''}`;
    default:
      return '(未知类型)';
  }
}

function flattenMerged(merged: MergedHookConfig[]): HookListItem[] {
  const items: HookListItem[] = [];
  for (const m of merged) {
    for (const h of m.hooks) {
      items.push({
        event: m.event,
        description: HOOK_EVENT_DESCRIPTIONS[m.event],
        matcher: m.matcher?.source ?? null,
        type: h.type,
        hint: describeHook(h),
        sources: m.sources,
        hookType: m.hookType,
        parallel: m.parallel,
        disabled: Boolean(h.disabled),
        key: makeHookKey(m.event, h),
      });
    }
  }
  return items;
}

async function buildSummary(workingDirectory: string | null): Promise<HookSummary> {
  const wd = workingDirectory || os.homedir();
  const configs = await loadAllHooksConfig(wd);
  const merged = mergeHooks(configs);
  const enabled = flattenMerged(merged);

  const enabledEvents = new Set(enabled.map((e) => e.event));
  const unused = ALL_HOOK_EVENTS
    .filter((e) => !enabledEvents.has(e))
    .map((event) => ({ event, description: HOOK_EVENT_DESCRIPTIONS[event] }));

  // 配置路径：返回新格式的首选路径（hooks.json），UI 用它做"打开配置"按钮
  const paths = getHooksConfigPaths(wd);
  const globalPath = paths.global[0]?.path ?? path.join(os.homedir(), CONFIG_DIR_NEW, 'hooks', 'hooks.json');
  const projectPath = workingDirectory ? (paths.project[0]?.path ?? null) : null;

  return {
    enabled,
    unused,
    configPaths: { global: globalPath, project: projectPath },
  };
}

/**
 * 把某条 hook 标记成停用/启用，直接改 hooks.json。
 * 只认新格式（hooks.json 顶层就是事件表）；legacy settings.json 不写，
 * 让调用方拿到明确失败而不是「点了没反应」。
 */
export async function setHookEnabled(
  filePath: string,
  key: string,
  enabled: boolean,
): Promise<{ matched: number }> {
  const fs = await import('fs');
  if (!fs.existsSync(filePath)) throw new Error(`配置文件不存在：${filePath}`);
  if (!filePath.endsWith('hooks.json')) {
    throw new Error('只支持在 hooks.json 里开关 hook，旧版 settings.json 请手工编辑');
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  let matched = 0;

  for (const [event, groups] of Object.entries(config)) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const hooks = (group as { hooks?: HookDefinition[] })?.hooks;
      if (!Array.isArray(hooks)) continue;
      for (const hook of hooks) {
        if (makeHookKey(event, hook) !== key) continue;
        matched += 1;
        if (enabled) delete hook.disabled;
        else hook.disabled = true;
      }
    }
  }

  if (matched === 0) throw new Error('没找到这条 hook，配置文件可能已被改动，请刷新后重试');
  fs.writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
  return { matched };
}

type HookRouteCtx = () => AgentApplicationService | null;

/**
 * hook 域单源路由表（RQ-183 续作·HOOK 刀）：原 domain switch 逐 case 平移（handler 返回 data，装配器包
 * { success: true, data }）；管理员门平移为 guard（分发前、未知 action 也先过门，门在装配器 try 内，与原顺序一致）；
 * 缺参抛错 / 未知 action → INVALID_ACTION `Unknown action: <action>` / 抛错 → INTERNAL_ERROR（Error 取 message、
 * 非 Error 取 String(error)），均为装配器缺省。请求体为 null / 非对象时，原实现在 try 外解构抛错（IPC 调用 reject），
 * 现先过门（非管理员 FORBIDDEN）、管理员下返回 INVALID_ACTION。
 */
const hookRoutes = defineDomainRoutes<HookDomainRequest, HookRouteCtx>(
  HookSchemas.REQUEST,
  {
    list: (getAppService) => buildSummary(getAppService()?.getWorkingDirectory() ?? null),
    openConfigFile: async (_ctx, payload) => {
      const { filePath } = payload as { filePath: string };
      if (!filePath) throw new Error('Missing filePath');
      // 不存在时，先确保父目录存在（让 shell 打开后用户能直接保存）
      const fs = await import('fs');
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (!fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, '{\n  "hooks": {}\n}\n', 'utf-8');
      }
      await shell.openPath(filePath);
      return { opened: filePath };
    },
    setEnabled: async (_ctx, payload) => {
      const { filePath, key, enabled } = payload as {
        filePath: string;
        key: string;
        enabled: boolean;
      };
      if (!filePath || !key) throw new Error('Missing filePath or key');
      return setHookEnabled(filePath, key, enabled);
    },
    revealConfigFolder: async (_ctx, payload) => {
      const { filePath } = payload as { filePath: string };
      if (!filePath) throw new Error('Missing filePath');
      shell.showItemInFolder(filePath);
      return { revealed: filePath };
    },
  },
  { guard: () => getAdminAccessIpcError('Hooks') },
);

export function registerHookHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null,
): void {
  installDomainRoutes(ipcMain, hookRoutes, getAppService);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerHookHandlers.routes = hookRoutes;
