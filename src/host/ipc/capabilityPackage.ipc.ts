import { IPC_CHANNELS } from '../../shared/ipc';
import type {
  CapabilityPackageInstallResult,
  CapabilityPackagePreview,
  CapabilityPackageResult,
  InstalledCapabilityPackage,
} from '../../shared/contract/capabilityPackage';
import { dialog, type AppWindow, type IpcMain } from '../platform';
import { getManualCapabilityPackageService } from '../services/capabilities/manualCapabilityPackageService';
import { isCurrentUserAdmin } from './adminGuard';

function success<T>(data: T): CapabilityPackageResult<T> {
  return { success: true, data };
}

function failure<T>(error: unknown): CapabilityPackageResult<T> {
  return { success: false, error: error instanceof Error ? error.message : String(error) };
}

export function registerCapabilityPackageHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => AppWindow | null,
): void {
  const guard = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (...args: TArgs) => Promise<CapabilityPackageResult<TResult>>,
  ): void => {
    ipcMain.handle(channel, async (_, ...args: unknown[]) => {
      if (!isCurrentUserAdmin()) return failure<TResult>('导入能力包需要管理员权限');
      return handler(...args as TArgs);
    });
  };

  guard(IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE, async (): Promise<CapabilityPackageResult<CapabilityPackagePreview | null>> => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return failure('当前没有可用窗口');
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '导入能力包',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: '能力包', extensions: ['zip', 'json'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    });
    if (picked.canceled || picked.filePaths.length === 0) return success(null);
    try {
      return success(await getManualCapabilityPackageService().stage(picked.filePaths[0]));
    } catch (error) {
      return failure(error);
    }
  });

  guard(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST, async (): Promise<CapabilityPackageResult<InstalledCapabilityPackage[]>> => {
    try {
      return success(await getManualCapabilityPackageService().list());
    } catch (error) {
      return failure(error);
    }
  });

  guard(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, async (token: string): Promise<CapabilityPackageResult<CapabilityPackageInstallResult>> => {
    try {
      return success(await getManualCapabilityPackageService().confirm(token));
    } catch (error) {
      return failure(error);
    }
  });

  guard(IPC_CHANNELS.CAPABILITY_PACKAGE_CANCEL, async (token: string): Promise<CapabilityPackageResult<void>> => {
    try {
      await getManualCapabilityPackageService().discard(token);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });

  guard(IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL, async (pluginId: string): Promise<CapabilityPackageResult<void>> => {
    try {
      await getManualCapabilityPackageService().uninstall(pluginId);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });
}
