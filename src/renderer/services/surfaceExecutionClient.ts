import type {
  SurfaceConversationSnapshotV1,
  SurfaceFramePayloadV1,
  SurfaceFrameRequestV1,
  SurfaceLiveStreamRequestV1,
  SurfaceLiveStreamStateV1,
  SurfaceOutputPayloadV1,
  SurfaceOutputRequestV1,
  SurfaceSessionControlRequestV1,
  SurfaceSessionControlResultV1,
  SurfaceTerminalFrameGetRequestV1,
  SurfaceTerminalFrameGetResultV1,
  SurfaceTerminalFramePersistRequestV1,
  SurfaceTerminalFramePersistResultV1,
  SurfaceTerminalFramesDeleteRequestV1,
  SurfaceTerminalFramesDeleteResultV1,
} from '@shared/contract/surfaceExecution';
import {
  isSurfaceConversationSnapshotV1,
  isSurfaceFramePayloadV1,
  isSurfaceLiveStreamStateV1,
  isSurfaceOutputPayloadV1,
  isSurfaceTerminalFrameGetResultV1,
  isSurfaceTerminalFramePersistResultV1,
  isSurfaceTerminalFramesDeleteResultV1,
} from '@shared/contract/surfaceExecution';
import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from './ipcService';

function isControlResult(value: unknown): value is SurfaceSessionControlResultV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<SurfaceSessionControlResultV1>;
  return candidate.version === 1
    && (candidate.requestId === undefined || typeof candidate.requestId === 'string')
    && isSurfaceConversationSnapshotV1(candidate.snapshot);
}

export async function getSurfaceExecutionSnapshot(
  conversationId: string,
): Promise<SurfaceConversationSnapshotV1> {
  const snapshot = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'getSnapshot',
    { version: 1, conversationId },
  );
  if (!isSurfaceConversationSnapshotV1(snapshot) || snapshot.conversationId !== conversationId) {
    throw new Error('Invalid Surface Execution snapshot');
  }
  return snapshot;
}

export async function controlSurfaceExecutionSession(
  request: SurfaceSessionControlRequestV1,
): Promise<SurfaceSessionControlResultV1> {
  const result = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'control',
    request,
  );
  if (!isControlResult(result) || result.snapshot.conversationId !== request.conversationId) {
    throw new Error('Invalid Surface Execution control result');
  }
  return result;
}

export async function getSurfaceExecutionFrame(
  request: SurfaceFrameRequestV1,
): Promise<SurfaceFramePayloadV1> {
  const frame = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'getFrame',
    request,
  );
  if (!isSurfaceFramePayloadV1(frame) || frame.assetRef !== request.assetRef) {
    throw new Error('Invalid Surface Execution frame');
  }
  return frame;
}

async function invokeLiveStream(
  action: 'startLiveStream' | 'stopLiveStream',
  request: SurfaceLiveStreamRequestV1,
): Promise<SurfaceLiveStreamStateV1> {
  const state = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    action,
    request,
  );
  if (!isSurfaceLiveStreamStateV1(state) || state.surfaceSessionId !== request.surfaceSessionId) {
    throw new Error('Invalid Surface Execution live stream state');
  }
  return state;
}

export async function startSurfaceLiveStream(
  request: SurfaceLiveStreamRequestV1,
): Promise<SurfaceLiveStreamStateV1> {
  return await invokeLiveStream('startLiveStream', request);
}

export async function stopSurfaceLiveStream(
  request: SurfaceLiveStreamRequestV1,
): Promise<SurfaceLiveStreamStateV1> {
  return await invokeLiveStream('stopLiveStream', request);
}

export async function getSurfaceExecutionOutput(
  request: SurfaceOutputRequestV1,
): Promise<SurfaceOutputPayloadV1> {
  const output = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'getOutput',
    request,
  );
  if (!isSurfaceOutputPayloadV1(output) || output.outputRef !== request.outputRef) {
    throw new Error('Invalid Surface Execution output');
  }
  return output;
}

/** 终态留影落盘：ok=false 是业务拒收（非 JPEG / 超限），不抛错，由调用方决定要不要记日志 */
export async function persistSurfaceTerminalFrame(
  request: SurfaceTerminalFramePersistRequestV1,
): Promise<SurfaceTerminalFramePersistResultV1> {
  const result = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'persistTerminalFrame',
    request,
  );
  if (!isSurfaceTerminalFramePersistResultV1(result)) {
    throw new Error('Invalid Surface Execution terminal frame persist result');
  }
  return result;
}

export async function getPersistedSurfaceTerminalFrame(
  request: SurfaceTerminalFrameGetRequestV1,
): Promise<SurfaceTerminalFrameGetResultV1> {
  const result = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'getPersistedTerminalFrame',
    request,
  );
  if (!isSurfaceTerminalFrameGetResultV1(result)) {
    throw new Error('Invalid Surface Execution persisted terminal frame result');
  }
  return result;
}

export async function deletePersistedSurfaceTerminalFrames(
  request: SurfaceTerminalFramesDeleteRequestV1,
): Promise<SurfaceTerminalFramesDeleteResultV1> {
  const result = await ipcService.invokeDomain<unknown>(
    IPC_DOMAINS.SURFACE_EXECUTION,
    'deletePersistedTerminalFrames',
    request,
  );
  if (!isSurfaceTerminalFramesDeleteResultV1(result)) {
    throw new Error('Invalid Surface Execution terminal frame delete result');
  }
  return result;
}
