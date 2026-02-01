// ============================================================================
// Evaluation IPC Handlers - 评测系统 IPC 处理器
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { EvaluationService } from '../evaluation';
import type { EvaluationExportFormat } from '../../shared/types/evaluation';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('EvaluationIPC');

/**
 * 注册评测相关的 IPC handlers
 */
export function registerEvaluationHandlers(): void {
  const service = EvaluationService.getInstance();

  // 执行评测
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_RUN,
    async (_event, payload: { sessionId: string; save?: boolean }) => {
      logger.info(`Running evaluation for session: ${payload.sessionId}`);
      return service.evaluateSession(payload.sessionId, { save: payload.save });
    }
  );

  // 获取评测结果
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_GET_RESULT,
    async (_event, evaluationId: string) => {
      return service.getResult(evaluationId);
    }
  );

  // 获取评测历史
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_LIST_HISTORY,
    async (_event, payload?: { sessionId?: string; limit?: number }) => {
      return service.listHistory(payload?.sessionId, payload?.limit);
    }
  );

  // 导出评测报告
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_EXPORT,
    async (
      _event,
      payload: {
        result: Parameters<typeof service.exportReport>[0];
        format: EvaluationExportFormat;
      }
    ) => {
      return service.exportReport(payload.result, payload.format);
    }
  );

  // 删除评测记录
  ipcMain.handle(
    IPC_CHANNELS.EVALUATION_DELETE,
    async (_event, evaluationId: string) => {
      return service.deleteResult(evaluationId);
    }
  );

  logger.info('Evaluation IPC handlers registered');
}
