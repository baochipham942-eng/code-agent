// ============================================================================
// Hook IPC Handlers - Hook 列表查询 + 配置文件打开
// ============================================================================

import * as path from 'path';
import * as os from 'os';
import { shell } from '../platform';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AgentApplicationService } from '../../shared/contract/appService';
import { CONFIG_DIR_NEW } from '../config/configPaths';
import { loadAllHooksConfig, getHooksConfigPaths, type HookDefinition } from '../hooks/configParser';
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

export function registerHookHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null,
): void {
  ipcMain.handle(IPC_DOMAINS.HOOK, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      const accessError = getAdminAccessIpcError('Hooks');
      if (accessError) return accessError;

      let data: unknown;

      switch (action) {
        case 'list': {
          const wd = getAppService()?.getWorkingDirectory() ?? null;
          data = await buildSummary(wd);
          break;
        }
        case 'openConfigFile': {
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
          data = { opened: filePath };
          break;
        }
        case 'revealConfigFolder': {
          const { filePath } = payload as { filePath: string };
          if (!filePath) throw new Error('Missing filePath');
          shell.showItemInFolder(filePath);
          data = { revealed: filePath };
          break;
        }
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });
}
