// ============================================================================
// Prompt IPC Handlers - 提示词管理（查看 + override）
// ============================================================================

import type { IpcMain } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import { PromptSchemas, type PromptDomainRequest } from '../../shared/ipc/schemas/prompt';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import type { PromptStackSummaryRequest } from '../../shared/contract/promptStack';
import {
  listPrompts,
  getPromptDetail,
  setPromptOverride,
  resetPromptOverride,
} from '../prompts/registry';
import { getCurrentPromptStackSummary } from '../services/promptStack';
import { getAdminAccessIpcError } from './adminGuard';
// 副作用 import：强制加载所有接入 registry 的 prompt 模块（包括没被 builder 直接引用的）
import '../prompts/promptIndex';

const PROMPT_DEBUG_ENV = 'CODE_AGENT_ALLOW_SYSTEM_PROMPT_DEBUG';

function getPromptIpcAccessError(action: string): IPCResponse | null {
  const adminError = getAdminAccessIpcError('Prompt Manager');
  if (adminError) return adminError;

  if (action === 'debugSystemPrompt' && process.env[PROMPT_DEBUG_ENV] !== '1') {
    return {
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: `Prompt Manager: full system prompt debug requires ${PROMPT_DEBUG_ENV}=1`,
      },
    };
  }

  return null;
}

/**
 * prompt 域单源路由表（RQ-183 续作·PROMPT 刀）：原 domain switch 逐 case 平移（handler 返回 data，
 * 装配器包 { success: true, data }）；guard 先于分发做管理员与 debug env 检查（未知 action 也先过门，
 * 与原 switch 顺序一致）；未知 action → INVALID_ACTION `Unknown action: <action>`、抛错 →
 * INTERNAL_ERROR + String(error)，均为装配器缺省行为，与原 switch 逐字一致。
 */
const promptRoutes = defineDomainRoutes<PromptDomainRequest, void>(
  PromptSchemas.REQUEST,
  {
    list: () => listPrompts(),
    get: (_ctx, payload) => {
      const { id } = payload as { id: string };
      return getPromptDetail(id);
    },
    set: (_ctx, payload) => {
      const { id, text } = payload as { id: string; text: string };
      setPromptOverride(id, text);
      return getPromptDetail(id);
    },
    reset: (_ctx, payload) => {
      const { id } = payload as { id: string };
      resetPromptOverride(id);
      return getPromptDetail(id);
    },
    preview: (_ctx, payload) => {
      // 取单个 prompt 当前生效的纯字符串值（Proxy.toString），用来端到端验证实时性
      const { id } = payload as { id: string };
      const detail = getPromptDetail(id);
      if (!detail) return null;
      // 这里直接用 detail.override ?? detail.defaultText，走一遍消费方路径更接近实际拼装时的行为
      const live = detail.override ?? detail.defaultText;
      return { id, live, length: live.length };
    },
    debugSystemPrompt: async () => {
      // 实拉一次 SYSTEM_PROMPT 完整文本，验证 override 是否进入 system prompt
      const { SYSTEM_PROMPT } = await import('../prompts/builder');
      const text = String(SYSTEM_PROMPT);
      return { length: text.length, preview: text.slice(0, 600), text };
    },
    stackSummary: (_ctx, payload) => getCurrentPromptStackSummary(payload as PromptStackSummaryRequest | undefined),
  },
  { guard: (action) => getPromptIpcAccessError(String(action)) },
);

/**
 * 注册 prompt 域 IPC handlers
 */
export function registerPromptHandlers(ipcMain: IpcMain): void {
  installDomainRoutes(ipcMain, promptRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerPromptHandlers.routes = promptRoutes;
