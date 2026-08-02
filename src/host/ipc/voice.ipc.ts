import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { RendererVoiceFailureReport } from '../../shared/contract/voice';
import { persistVoiceCallFailure } from '../services/voice/voiceFailurePersistence';

function isRendererFailure(payload: unknown): payload is RendererVoiceFailureReport {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<RendererVoiceFailureReport>;
  if (typeof value.neoSessionId !== 'string' || !value.neoSessionId.trim()) return false;
  return (value.code === 'HANDSHAKE_FAILED' && value.phase === 'handshake')
    || (value.code === 'RECONNECT_FAILED' && value.phase === 'reconnect');
}

export function registerVoiceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.VOICE, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    if (request.action !== 'reportFailure') {
      return { success: false, error: { code: 'UNKNOWN_ACTION', message: `Unknown voice action: ${request.action}` } };
    }
    if (!isRendererFailure(request.payload)) {
      return { success: false, error: { code: 'INVALID_ARGS', message: 'Invalid renderer voice failure report' } };
    }
    await persistVoiceCallFailure(request.payload);
    return { success: true };
  });
}
