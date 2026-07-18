import type { IpcInvokeHandlers } from '@shared/ipc';
import type { SkillChannel } from '@shared/ipc/channels';
import { createLogger } from '../utils/logger';
import ipcService from './ipcService';

const logger = createLogger('invokeSkillIPC');

export async function invokeSkillIPC<K extends SkillChannel>(
  channel: K,
  ...args: Parameters<IpcInvokeHandlers[K]>
): Promise<Awaited<ReturnType<IpcInvokeHandlers[K]>> | undefined> {
  try {
    return await ipcService.invoke(channel, ...args);
  } catch (error) {
    logger.warn(`IPC invoke failed for ${channel}`, { error });
    return undefined;
  }
}
