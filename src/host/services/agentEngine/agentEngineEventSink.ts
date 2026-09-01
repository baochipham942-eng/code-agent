import type { AgentEvent } from '../../../shared/contract';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { AppWindow } from '../../platform';
import { envelopeRendererAgentEvent } from '../../protocol/rendererAgentStreamCursor';

export function emitExternalAgentEvent(
  sessionId: string,
  event: AgentEvent,
  localSink?: (event: AgentEvent) => void,
): void {
  if (localSink) {
    localSink(event);
    return;
  }
  const payload = envelopeRendererAgentEvent(sessionId, event);
  for (const win of AppWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.AGENT_EVENT, payload);
  }
}
