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

export function resolveWorkingDirectory(
  payload: unknown,
  getAppService: () => AgentApplicationService | null,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const requested = payload && typeof payload === 'object'
    ? (payload as { workingDirectory?: unknown }).workingDirectory
    : undefined;
  if (typeof requested === 'string' && requested.trim()) return requested;
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
      const workingDirectory = resolveWorkingDirectory(request.payload, getAppService);
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
