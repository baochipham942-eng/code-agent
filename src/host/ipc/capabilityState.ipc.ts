import type {
  BundledHostCapabilityId,
  BundledHostCapabilityReadiness,
  BundledHostCapabilityState,
} from '../../shared/contract/bundledHostCapability';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { IpcMain } from '../platform';
import {
  getBundledHostCapabilityRegistry,
  type BundledHostCapabilityRegistry,
} from '../services/capabilities/bundledHostCapabilityRegistry';

type CapabilityStateService = Pick<
  BundledHostCapabilityRegistry,
  'getReadiness' | 'install' | 'listStates' | 'uninstall'
>;

export function registerCapabilityStateHandlers(
  ipcMain: IpcMain,
  registry: CapabilityStateService = getBundledHostCapabilityRegistry(),
): void {
  ipcMain.handle(
    IPC_CHANNELS.CAPABILITY_STATE_LIST,
    async (): Promise<BundledHostCapabilityState[]> => registry.listStates(),
  );
  ipcMain.handle(
    IPC_CHANNELS.CAPABILITY_STATE_INSTALL,
    async (_event, id: BundledHostCapabilityId): Promise<void> => registry.install(id, { source: 'user' }),
  );
  ipcMain.handle(
    IPC_CHANNELS.CAPABILITY_STATE_UNINSTALL,
    async (_event, id: BundledHostCapabilityId): Promise<void> => registry.uninstall(id),
  );
  ipcMain.handle(
    IPC_CHANNELS.CAPABILITY_STATE_READINESS,
    async (_event, id: BundledHostCapabilityId): Promise<BundledHostCapabilityReadiness> => registry.getReadiness(id),
  );
}
