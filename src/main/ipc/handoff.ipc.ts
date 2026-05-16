// ============================================================================
// Handoff IPC Handlers
// ============================================================================

import type { IpcMain } from '../platform';
import { HANDOFF_CHANNELS } from '../../shared/ipc/channels';
import type {
  ListHandoffProposalsInput,
  UpdateHandoffProposalStatusInput,
} from '../../shared/contract/handoff';
import { getHandoffProposalService } from '../handoff';

export function registerHandoffHandlers(ipcMain: IpcMain): void {
  const service = getHandoffProposalService();

  ipcMain.handle(
    HANDOFF_CHANNELS.LIST,
    async (_event, payload?: ListHandoffProposalsInput) => service.list(payload || {}),
  );

  ipcMain.handle(
    HANDOFF_CHANNELS.UPDATE_STATUS,
    async (_event, payload: UpdateHandoffProposalStatusInput) => service.updateStatus(payload),
  );
}
