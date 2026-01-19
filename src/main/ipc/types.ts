// ============================================================================
// IPC Types - IPC 处理器类型定义
// ============================================================================

import type { IpcMain } from 'electron';

/**
 * IPC 处理器注册函数类型
 * 每个领域模块导出一个 registerXxxHandlers 函数
 */
export type IpcHandlerRegistrar = (ipcMain: IpcMain) => void;

/**
 * IPC 领域模块接口
 */
export interface IpcModule {
  /** 模块名称 */
  name: string;
  /** 注册处理器 */
  register: IpcHandlerRegistrar;
}
