import type { IpcMain } from '@host/platform';
import { getEvalRunBridge } from './evaluation/evalRunBridge';
import { registerEvaluationHandlers } from './ipc/evaluation.ipc';

interface InternalHostSdkContext {
  version: string;
  modules: Readonly<Record<string, unknown>>;
}

interface ActivateContext {
  ipcMain: IpcMain;
  sdk: InternalHostSdkContext;
}

export async function activate({ ipcMain, sdk: _sdk }: ActivateContext): Promise<{ deactivate: () => Promise<void> }> {
  const registration = registerEvaluationHandlers(ipcMain);
  let active = true;
  return {
    async deactivate() {
      if (!active) return;
      active = false;
      for (const channel of registration.channels) ipcMain.removeHandler(channel);
      registration.disposeAdmin();
      await getEvalRunBridge().abortAll('插件正在更新');
    },
  };
}
