// ============================================================================
// Lab IPC Handlers - lab:* 通道
// 处理实验室模型训练相关的 IPC 通信
// ============================================================================

import type { IpcMain, BrowserWindow } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getLabService } from '../services/lab';
import type {
  LabProjectType,
  DownloadProjectRequest,
  UploadDataRequest,
  StartTrainingRequest,
  InferenceRequest,
} from '../../shared/types/lab';

// ----------------------------------------------------------------------------
// Public Registration
// ----------------------------------------------------------------------------

/**
 * 注册 Lab 相关 IPC handlers
 */
export function registerLabHandlers(
  ipcMain: IpcMain,
  getMainWindow: () => BrowserWindow | null
): void {
  const labService = getLabService();

  // 设置主窗口引用
  const mainWindow = getMainWindow();
  if (mainWindow) {
    labService.setMainWindow(mainWindow);
  }

  // 检查 Python 环境
  ipcMain.handle(IPC_CHANNELS.LAB_CHECK_PYTHON_ENV, async () => {
    return labService.checkPythonEnv();
  });

  // 获取项目状态
  ipcMain.handle(IPC_CHANNELS.LAB_GET_PROJECT_STATUS, async (_, projectType: LabProjectType) => {
    return labService.getProjectStatus(projectType);
  });

  // 下载项目
  ipcMain.handle(IPC_CHANNELS.LAB_DOWNLOAD_PROJECT, async (_, request: DownloadProjectRequest) => {
    return labService.downloadProject(request);
  });

  // 上传数据
  ipcMain.handle(IPC_CHANNELS.LAB_UPLOAD_DATA, async (_, request: UploadDataRequest) => {
    return labService.uploadData(request);
  });

  // 开始训练
  ipcMain.handle(IPC_CHANNELS.LAB_START_TRAINING, async (_, request: StartTrainingRequest) => {
    // 确保主窗口引用是最新的
    const currentWindow = getMainWindow();
    if (currentWindow) {
      labService.setMainWindow(currentWindow);
    }
    return labService.startTraining(request);
  });

  // 停止训练
  ipcMain.handle(IPC_CHANNELS.LAB_STOP_TRAINING, async (_, projectType: LabProjectType) => {
    return labService.stopTraining(projectType);
  });

  // 推理测试
  ipcMain.handle(IPC_CHANNELS.LAB_INFERENCE, async (_, request: InferenceRequest) => {
    return labService.inference(request);
  });
}
