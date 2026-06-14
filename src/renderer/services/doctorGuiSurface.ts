import { IPC_DOMAINS } from '@shared/ipc';
import ipcService from './ipcService';

export async function runDoctorViaGuiSurface<T = unknown>(): Promise<T> {
  return ipcService.invokeDomain<T>(IPC_DOMAINS.PROVIDER, 'run_doctor');
}
