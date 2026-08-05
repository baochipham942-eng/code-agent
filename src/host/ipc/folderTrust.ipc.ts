import os from 'node:os';
import path from 'node:path';
import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { AgentApplicationService } from '../../shared/contract/appService';
import {
  evaluateFolderTrust,
  revokeFolderTrust,
  setFolderTrust,
  type FolderTrustDecisionState,
} from '../security/folderTrustService';

/**
 * 解析会话绑定的 workingDirectory。
 * 默认走 DB 同步读（不拉消息）；测试可注入 mock。
 * 解析失败/无 cwd 时返回 null，由调用方继续走 WEB_MODE / app 级兜底。
 */
export type SessionWorkingDirectoryResolver = (
  sessionId: string,
) => string | null | undefined | Promise<string | null | undefined>;

async function defaultResolveSessionWorkingDirectory(sessionId: string): Promise<string | null> {
  try {
    // 轻量同步路径：只读 sessions 行，不走 SessionManager 的消息懒加载。
    const { getDatabase } = await import('../services/core/databaseService');
    const cwd = getDatabase().getSession(sessionId)?.workingDirectory?.trim();
    return cwd || null;
  } catch {
    return null;
  }
}

/**
 * 信任评估对象解析优先级：
 * 1. payload.workingDirectory（显式，调用方已知道目标目录）
 * 2. payload.sessionId → 会话绑定 workingDirectory
 * 3. WEB_MODE 兜底 → <dataDir>/work（无会话时的快速对话默认）
 * 4. app 级 getWorkingDirectory
 * 5. process.cwd()
 *
 * 注意：桌面 app 经 webServer 恒 CODE_AGENT_WEB_MODE=true，所以「会话优先」
 * 必须排在 WEB_MODE 分支之前，否则项目会话永远评到 <dataDir>/work。
 */
export async function resolveWorkingDirectory(
  payload: unknown,
  getAppService: () => AgentApplicationService | null,
  env: NodeJS.ProcessEnv = process.env,
  resolveSessionWorkingDirectory: SessionWorkingDirectoryResolver = defaultResolveSessionWorkingDirectory,
): Promise<string> {
  const record = payload && typeof payload === 'object'
    ? (payload as { workingDirectory?: unknown; sessionId?: unknown })
    : undefined;

  const requested = record?.workingDirectory;
  if (typeof requested === 'string' && requested.trim()) return requested;

  const sessionId = typeof record?.sessionId === 'string' ? record.sessionId.trim() : '';
  if (sessionId) {
    try {
      const sessionCwd = await resolveSessionWorkingDirectory(sessionId);
      if (typeof sessionCwd === 'string' && sessionCwd.trim()) {
        return sessionCwd.trim();
      }
    } catch {
      // 解析失败：继续走兜底链，不把错误吞成错误目录的「假信任」。
    }
  }

  if (env.CODE_AGENT_WEB_MODE === 'true') {
    const dataDir = env.CODE_AGENT_DATA_DIR?.trim() || path.join(os.homedir(), '.code-agent');
    // 与 web /api/run 的 ensureDefaultWebWorkingDirectory 保持同一真相源。
    return path.join(path.resolve(dataDir), 'work');
  }
  const appWorkingDirectory = getAppService()?.getWorkingDirectory();
  if (appWorkingDirectory) return appWorkingDirectory;
  return process.cwd();
}

export function registerFolderTrustHandlers(
  ipcMain: IpcMain,
  getAppService: () => AgentApplicationService | null,
): void {
  ipcMain.handle(IPC_DOMAINS.FOLDER_TRUST, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    try {
      const workingDirectory = await resolveWorkingDirectory(request.payload, getAppService);
      let data: unknown;

      switch (request.action) {
        case 'get':
          data = await evaluateFolderTrust(workingDirectory);
          break;
        case 'set': {
          const payload = request.payload as { state?: FolderTrustDecisionState; decidedBy?: string } | undefined;
          if (payload?.state !== 'trusted' && payload?.state !== 'blocked') {
            return {
              success: false,
              error: { code: 'INVALID_PAYLOAD', message: 'folderTrust:set requires state trusted or blocked.' },
            };
          }
          data = await setFolderTrust(workingDirectory, payload.state, payload.decidedBy);
          break;
        }
        case 'revoke':
          data = await revokeFolderTrust(workingDirectory);
          break;
        default:
          return {
            success: false,
            error: { code: 'INVALID_ACTION', message: `Unknown action: ${request.action}` },
          };
      }

      return { success: true, data };
    } catch (error) {
      return {
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  });
}
