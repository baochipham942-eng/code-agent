import type { ProjectMemoryDraftResult } from '@shared/contract/memory';
import { IPC_DOMAINS } from '@shared/ipc';
import { useStatusStore } from '../stores/statusStore';
import ipcService from './ipcService';

/** GUI 面的 /init-memory 入口：memory 域 IPC 调 host 侧 draftProjectMemory。
 *  工作目录取会话当前 cwd（statusStore 真源），未就绪时明确报错而非扫描错误目录。 */
export async function initProjectMemoryViaGuiSurface(): Promise<ProjectMemoryDraftResult> {
  const projectDir = useStatusStore.getState().workingDirectory;
  if (!projectDir) {
    throw new Error('working directory is not available yet');
  }
  return ipcService.invokeDomain<ProjectMemoryDraftResult>(
    IPC_DOMAINS.MEMORY,
    'memoryInitProjectDraft',
    { projectDir },
  );
}
