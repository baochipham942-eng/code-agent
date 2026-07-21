import type {
  SurfaceConversationSnapshotV1,
  SurfaceFramePayloadV1,
  SurfaceFrameRequestV1,
  SurfaceOutputPayloadV1,
  SurfaceOutputRequestV1,
  SurfaceSessionControlRequestV1,
  SurfaceSessionControlResultV1,
} from '@shared/contract/surfaceExecution';
import {
  isSurfaceConversationSnapshotV1,
  isSurfaceFramePayloadV1,
  isSurfaceOutputPayloadV1,
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
