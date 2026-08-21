import type { AgentEventEnvelope } from '../../../shared/contract';
import { IPC_CHANNELS } from '../../../shared/ipc';
import { AppWindow } from '../../platform';

export function emitExternalAgentEvent(
  sessionId: string,
  event: AgentEventEnvelope,
  localSink?: (event: AgentEventEnvelope) => void,
): void {
  if (localSink) {
    localSink(event);
    return;
  }
  const payload = { ...event, sessionId };
  for (const win of AppWindow.getAllWindows()) {
    win.webContents.send(IPC_CHANNELS.AGENT_EVENT, payload);
  }
}
