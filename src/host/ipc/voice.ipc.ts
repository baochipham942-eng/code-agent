import type { IpcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import type { RendererVoiceFailureReport, VoiceUserTextInjectionResult } from '../../shared/contract/voice';
import { persistVoiceCallFailure } from '../services/voice/voiceFailurePersistence';
import { injectVoiceUserText } from '../services/voice/voiceSessionService';
import {
  clearVoiceprintData,
  getVoiceprintOverview,
  prepareVoiceprintModel,
  registerVoiceprintFromActiveCall,
} from '../services/voice/voiceprintService';

function isRendererFailure(payload: unknown): payload is RendererVoiceFailureReport {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as Partial<RendererVoiceFailureReport>;
  if (typeof value.neoSessionId !== 'string' || !value.neoSessionId.trim()) return false;
  return (value.code === 'HANDSHAKE_FAILED' && value.phase === 'handshake')
    || (value.code === 'RECONNECT_FAILED' && value.phase === 'reconnect');
}

function isUserTextInjection(payload: unknown): payload is { neoSessionId: string; text: string } {
  if (!payload || typeof payload !== 'object') return false;
  const value = payload as { neoSessionId?: unknown; text?: unknown };
  return typeof value.neoSessionId === 'string'
    && value.neoSessionId.trim().length > 0
    && typeof value.text === 'string'
    && value.text.trim().length > 0;
}

export function registerVoiceHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(IPC_DOMAINS.VOICE, async (_event, request: IPCRequest): Promise<IPCResponse> => {
    if (request.action === 'injectUserText') {
      if (!isUserTextInjection(request.payload)) {
        return { success: false, error: { code: 'INVALID_ARGS', message: 'Invalid voice user text injection' } };
      }
      const result = await injectVoiceUserText(request.payload.neoSessionId, request.payload.text);
      return { success: true, data: result } satisfies IPCResponse<VoiceUserTextInjectionResult>;
    }
    // 声纹（N-L7-SPK）：四个动作都不带 payload，也绝不在响应里携带 embedding 向量。
    if (request.action === 'voiceprintOverview') {
      return { success: true, data: getVoiceprintOverview() };
    }
    if (request.action === 'voiceprintRegister') {
      return { success: true, data: registerVoiceprintFromActiveCall() };
    }
    if (request.action === 'voiceprintClear') {
      return { success: true, data: clearVoiceprintData() };
    }
    if (request.action === 'voiceprintPrepareModel') {
      try {
        return { success: true, data: await prepareVoiceprintModel() };
      } catch (error) {
        return {
          success: false,
          error: { code: 'DOWNLOAD_FAILED', message: error instanceof Error ? error.message : 'download failed' },
        };
      }
    }
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
