import type { BundledHostCapabilityState } from '../../shared/contract/bundledHostCapability';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { IpcMain } from '../platform';
import {
  getBundledHostCapabilityRegistry,
  type BundledHostCapabilityRegistry,
} from '../services/capabilities/bundledHostCapabilityRegistry';

type CapabilityStateReader = Pick<BundledHostCapabilityRegistry, 'listStates'>;

export function registerCapabilityStateHandlers(
  ipcMain: IpcMain,
  registry: CapabilityStateReader = getBundledHostCapabilityRegistry(),
): void {
  ipcMain.handle(
    IPC_CHANNELS.CAPABILITY_STATE_LIST,
    async (): Promise<BundledHostCapabilityState[]> => registry.listStates(),
  );
}
