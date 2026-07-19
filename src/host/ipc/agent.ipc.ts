// ============================================================================
// Agent IPC Handlers - agent:* 通道
// ============================================================================

import type { IpcMain } from '../platform';
import {
  IPC_CHANNELS,
  IPC_DOMAINS,
  type AgentCancelRequest,
  type AgentMessageRequest,
  type AgentPermissionResponseRequest,
  type IPCRequest,
  type IPCResponse
} from '../../shared/ipc';
import type { PermissionResponse } from '../../shared/contract';
import type { AgentApplicationService, AppServiceRunOptions } from '../../shared/contract/appService';
import type { ConversationEnvelope } from '../../shared/contract/conversationEnvelope';
import type {
  AgentTreeRequest,
  AgentWorktreeReviewRequest,
} from '../../shared/contract/agentTree';
import { getAgentTreeSnapshot } from '../agent/agentTreeService';
import { getAgentWorktreeReview } from '../agent/agentWorktree';
import {
  MODE_CONFIGS,
  getPermissionModeManager,
  setPermissionMode,
  type PermissionMode,
} from '../permissions/modes';
import { broadcastToRenderer } from '../platform';
import { getAdminAccessIpcError } from './adminGuard';
import type { SteerOrQueueOutcome } from '../runtime/steerQueueFence';

// ----------------------------------------------------------------------------
// Internal Handlers
// ----------------------------------------------------------------------------

interface SendMessagePayload {
  content: string;
  clientMessageId?: string;
  sessionId?: string;
  attachments?: unknown[];
  options?: AppServiceRunOptions;
  context?: ConversationEnvelope['context'];
}

function normalizeEnvelope(
  payload: string | AgentMessageRequest | SendMessagePayload | ConversationEnvelope
): ConversationEnvelope {
  if (typeof payload === 'string') {
    return { content: payload };
  }

  return {
    content: payload.content,
    ...('clientMessageId' in payload && payload.clientMessageId ? { clientMessageId: payload.clientMessageId } : {}),
    ...(payload.sessionId ? { sessionId: payload.sessionId } : {}),
    ...(payload.attachments ? { attachments: payload.attachments as ConversationEnvelope['attachments'] } : {}),
    ...(payload.options ? { options: payload.options } : {}),
    ...(payload.context ? { context: payload.context } : {}),
  };
}

async function handleSendMessage(
  getAppService: () => AgentApplicationService | null,
  payload: string | AgentMessageRequest | SendMessagePayload | ConversationEnvelope
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  await appService.sendMessage(normalizeEnvelope(payload));
}

async function handleCancel(
  getAppService: () => AgentApplicationService | null,
  payload?: AgentCancelRequest
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  await appService.cancel(payload?.sessionId);
}

async function handlePermissionResponse(
  getAppService: () => AgentApplicationService | null,
  payload: AgentPermissionResponseRequest
): Promise<void> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  appService.handlePermissionResponse(payload.requestId, payload.response, payload.sessionId);
}

interface InterruptPayload {
  content: string;
  clientMessageId?: string;
  sessionId?: string;
  attachments?: unknown[];
  options?: AppServiceRunOptions;
  context?: ConversationEnvelope['context'];
}

async function handleInterrupt(
  getAppService: () => AgentApplicationService | null,
  payload: string | AgentMessageRequest | InterruptPayload | ConversationEnvelope
): Promise<SteerOrQueueOutcome> {
  const appService = getAppService();
  if (!appService) throw new Error('Agent not initialized');
  return appService.interruptAndContinue(normalizeEnvelope(payload));
}

function normalizePermissionMode(value: unknown): PermissionMode | null {
  if (typeof value !== 'string') return null;
  return value in MODE_CONFIGS ? value as PermissionMode : null;
}

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Agent 相关 IPC handlers
 */
export function registerAgentHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null
): void {
  // ========== New Domain Handler (TASK-04) ==========
  ipcMain.handle(IPC_DOMAINS.AGENT, async (_, request: IPCRequest): Promise<IPCResponse> => {
    const { action, payload } = request;

    try {
      switch (action) {
        case 'send':
          await handleSendMessage(getAppService, payload as string | SendMessagePayload | ConversationEnvelope);
          return { success: true, data: null };
        case 'cancel':
          await handleCancel(getAppService, payload as AgentCancelRequest | undefined);
          return { success: true, data: null };
        case 'permissionResponse':
          await handlePermissionResponse(getAppService, payload as AgentPermissionResponseRequest);
          return { success: true, data: null };
        case 'interrupt': {
          const outcome = await handleInterrupt(getAppService, payload as string | InterruptPayload | ConversationEnvelope);
          return { success: true, data: outcome };
        }
        case 'setEffortLevel': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.setEffortLevel((payload as { level: import('../../shared/contract/agent').EffortLevel }).level);
          return { success: true, data: null };
        }
        case 'setThinkingEnabled': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.setThinkingEnabled(Boolean((payload as { enabled?: boolean }).enabled));
          return { success: true, data: null };
        }
        case 'setInteractionMode': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.setInteractionMode((payload as { mode: import('../../shared/contract/agent').InteractionMode }).mode);
          return { success: true, data: null };
        }
        case 'setPermissionMode': {
          const mode = normalizePermissionMode((payload as { mode?: unknown } | undefined)?.mode);
          if (!mode) {
            return {
              success: false,
              error: { code: 'INVALID_PERMISSION_MODE', message: 'Unknown permission mode' },
            };
          }
          // 审出 MED：需审批档（bypassPermissions）的提档必须过 admin 门，
          // 与 settings PERMISSION_SET_MODE 的 assertAdminAccess 同一口径——
          // approved 由客户端自报，不能作为提权凭据。
          if (MODE_CONFIGS[mode].requiresApproval) {
            const adminError = getAdminAccessIpcError('Permission mode');
            if (adminError) return adminError;
          }
          const changed = setPermissionMode(mode, Boolean((payload as { approved?: boolean } | undefined)?.approved));
          return { success: true, data: { changed, mode } };
        }
        case 'getSessionPermissionMode': {
          const sessionId = (payload as { sessionId?: string } | undefined)?.sessionId;
          return {
            success: true,
            data: { mode: getPermissionModeManager().getModeForSession(sessionId) },
          };
        }
        case 'setSessionPermissionMode': {
          const req = (payload ?? {}) as { sessionId?: string; mode?: unknown; approved?: boolean };
          const mode = normalizePermissionMode(req.mode);
          if (!mode || !req.sessionId) {
            return {
              success: false,
              error: { code: 'INVALID_PERMISSION_MODE', message: 'sessionId and a valid mode are required' },
            };
          }
          // 审出 MED：会话粒度提档到需审批档（bypassPermissions）同样过 admin 门，
          // 否则 hosted/多用户部署下非 admin 客户端可借 approved 自报把任意会话提到 bypass，
          // 绕开全局 PERMISSION_SET_MODE 的 assertAdminAccess。普通档位切换不受影响。
          if (MODE_CONFIGS[mode].requiresApproval) {
            const adminError = getAdminAccessIpcError('Session permission mode');
            if (adminError) return adminError;
          }
          const manager = getPermissionModeManager();
          const changed = manager.setSessionMode(req.sessionId, mode, Boolean(req.approved));
          if (changed) {
            // 单一真源：档位状态只存在于 PermissionModeManager，变更即广播，
            // 所有消费方（会话内切换器/设置页）从广播同步，不留 pending 中转 state。
            broadcastToRenderer(IPC_CHANNELS.PERMISSION_MODE_CHANGED, {
              scope: 'session',
              sessionId: req.sessionId,
              mode: manager.getModeForSession(req.sessionId),
            });
          }
          return { success: true, data: { changed, mode: manager.getModeForSession(req.sessionId) } };
        }
        case 'pause': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.pause((payload as { sessionId?: string })?.sessionId);
          return { success: true, data: null };
        }
        case 'resume': {
          const appService = getAppService();
          if (!appService) throw new Error('Agent not initialized');
          appService.resume((payload as { sessionId?: string })?.sessionId);
          return { success: true, data: null };
        }
        case 'getTree':
          return {
            success: true,
            data: getAgentTreeSnapshot(payload as AgentTreeRequest | undefined),
          };
        case 'getWorktreeReview': {
          const agentId = (payload as AgentWorktreeReviewRequest | undefined)?.agentId?.trim();
          if (!agentId) {
            return {
              success: false,
              error: { code: 'INVALID_AGENT_ID', message: 'agentId is required' },
            };
          }
          return {
            success: true,
            data: await getAgentWorktreeReview(agentId),
          };
        }
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
          };
      }
    } catch (error) {
      return {
        success: false,
        error: { code: 'INTERNAL_ERROR', message: error instanceof Error ? error.message : String(error) },
      };
    }
  });

  // ========== Legacy Handlers (Deprecated) ==========

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'send' */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_SEND_MESSAGE,
    async (_, payload: string | SendMessagePayload) => {
      return handleSendMessage(getAppService, payload);
    }
  );

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'cancel' */
  ipcMain.handle(IPC_CHANNELS.AGENT_CANCEL, async (_, payload?: AgentCancelRequest) => {
    return handleCancel(getAppService, payload);
  });

  /** @deprecated Use IPC_DOMAINS.AGENT with action: 'permissionResponse' */
  ipcMain.handle(
    IPC_CHANNELS.AGENT_PERMISSION_RESPONSE,
    async (_, requestId: string, response: PermissionResponse, sessionId?: string) => {
      return handlePermissionResponse(getAppService, { requestId, response, sessionId });
    }
  );
}
