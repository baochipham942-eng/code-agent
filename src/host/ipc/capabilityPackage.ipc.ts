import { IPC_CHANNELS } from '../../shared/ipc';
import type {
  CapabilityPackageInstallResult,
  CapabilityPackagePreview,
  CapabilityPackageResult,
  InstalledCapabilityPackage,
} from '../../shared/contract/capabilityPackage';
import { dialog, type AppWindow, type IpcMain } from '../platform';
import { getManualCapabilityPackageService } from '../services/capabilities/manualCapabilityPackageService';
import { isBuiltinCapabilityId } from '../plugins/builtin/builtinCapabilityIds';

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
  const handle = <TArgs extends unknown[], TResult>(
    channel: string,
    handler: (...args: TArgs) => Promise<CapabilityPackageResult<TResult>>,
  ): void => {
    ipcMain.handle(channel, async (_, ...args: unknown[]) => handler(...args as TArgs));
  };

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_SELECT_STAGE, async (): Promise<CapabilityPackageResult<CapabilityPackagePreview | null>> => {
    const mainWindow = getMainWindow();
    if (!mainWindow) return failure('当前没有可用窗口');
    const picked = await dialog.showOpenDialog(mainWindow, {
      title: '导入插件',
      properties: ['openFile', 'openDirectory'],
      filters: [
        { name: '插件', extensions: ['zip', 'json'] },
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

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_PATH, async (selectedPath: string): Promise<CapabilityPackageResult<CapabilityPackagePreview>> => {
    if (!selectedPath?.trim()) return failure('没有收到可导入的插件路径');
    try {
      return success(await getManualCapabilityPackageService().stage(selectedPath));
    } catch (error) {
      return failure(error);
    }
  });

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_LIST, async (): Promise<CapabilityPackageResult<InstalledCapabilityPackage[]>> => {
    try {
      return success(await getManualCapabilityPackageService().list());
    } catch (error) {
      return failure(error);
    }
  });

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_STAGE_BUNDLED, async (pluginId: string): Promise<CapabilityPackageResult<CapabilityPackagePreview>> => {
    if (!isBuiltinCapabilityId(pluginId)) return failure('只允许安装 Neo 内置插件');
    try {
      return success(await getManualCapabilityPackageService().stageBundled(pluginId));
    } catch (error) {
      return failure(error);
    }
  });

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_CONFIRM, async (token: string): Promise<CapabilityPackageResult<CapabilityPackageInstallResult>> => {
    try {
      const service = getManualCapabilityPackageService();
      if (!await service.getStagedPackageSource(token)) return failure('插件确认来源无效或已过期');
      return success(await service.confirm(token));
    } catch (error) {
      return failure(error);
    }
  });

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_CANCEL, async (token: string): Promise<CapabilityPackageResult<void>> => {
    try {
      const service = getManualCapabilityPackageService();
      if (!await service.getStagedPackageSource(token)) return failure('插件确认来源无效或已过期');
      await service.discard(token);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });

  handle(IPC_CHANNELS.CAPABILITY_PACKAGE_UNINSTALL, async (pluginId: string): Promise<CapabilityPackageResult<void>> => {
    try {
      const service = getManualCapabilityPackageService();
      if (!await service.getInstalledPackageSource(pluginId)) return failure('只允许卸载 Neo 内置或本机导入的插件');
      await service.uninstall(pluginId);
      return success(undefined);
    } catch (error) {
      return failure(error);
    }
  });
}
