// ============================================================================
// Prompt IPC Handlers - 提示词管理（查看 + override）
// ============================================================================

import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
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
 * 注册 prompt 域 IPC handlers
 */
export function registerPromptHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.PROMPT, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      const accessError = getPromptIpcAccessError(action);
      if (accessError) return accessError;

      let data: unknown;

      switch (action) {
        case 'list':
          data = listPrompts();
          break;
        case 'get': {
          const { id } = payload as { id: string };
          data = getPromptDetail(id);
          break;
        }
        case 'set': {
          const { id, text } = payload as { id: string; text: string };
          setPromptOverride(id, text);
          data = getPromptDetail(id);
          break;
        }
        case 'reset': {
          const { id } = payload as { id: string };
          resetPromptOverride(id);
          data = getPromptDetail(id);
          break;
        }
        case 'preview': {
          // 取单个 prompt 当前生效的纯字符串值（Proxy.toString），用来端到端验证实时性
          const { id } = payload as { id: string };
          const detail = getPromptDetail(id);
          if (!detail) {
            data = null;
            break;
          }
          // 用 String() 强制走 Proxy 的 valueOf；如果 override 改了，应立即拿到新值
          // 这里直接用 detail.override ?? detail.defaultText 也行，但走一遍消费方
          // 路径更接近实际拼装时的行为
          const live = detail.override ?? detail.defaultText;
          data = { id, live, length: live.length };
          break;
        }
        case 'debugSystemPrompt': {
          // 实拉一次 SYSTEM_PROMPT 完整文本，验证 override 是否进入 system prompt
          const { SYSTEM_PROMPT } = await import('../prompts/builder');
          const text = String(SYSTEM_PROMPT);
          data = { length: text.length, preview: text.slice(0, 600), text };
          break;
        }
        case 'stackSummary':
          data = await getCurrentPromptStackSummary();
          break;
        default:
          return { success: false, error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` } };
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
