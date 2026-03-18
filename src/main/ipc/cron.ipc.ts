// ============================================================================
// Cron IPC Handlers
// ============================================================================

import { ipcMain } from 'electron';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getCronService } from '../cron/cronService';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('CronIPC');

const CRON_GENERATION_SYSTEM_PROMPT = `你是一个定时任务配置助手。根据用户的自然语言描述，生成定时任务的 JSON 配置。

只返回一个 JSON 对象，不要有其他文字。JSON 格式如下：

{
  "name": "任务名称",
  "description": "任务描述",
  "enabled": true,
  "scheduleType": "every" | "cron" | "at",
  "schedule": {
    // every 类型: { "type": "every", "interval": 数字, "unit": "seconds"|"minutes"|"hours"|"days"|"weeks" }
    // cron 类型: { "type": "cron", "expression": "cron表达式", "timezone": "Asia/Shanghai" }
    // at 类型: { "type": "at", "datetime": "ISO时间字符串" }
  },
  "action": {
    // shell 类型: { "type": "shell", "command": "命令" }
    // webhook 类型: { "type": "webhook", "url": "地址", "method": "POST", "headers": {}, "body": {} }
  },
  "tags": ["标签"],
  "maxRetries": 0,
  "timeout": null
}

注意：
- 如果用户没有明确说动作类型，默认用 shell
- 时区默认 Asia/Shanghai
- 尽量从描述中推断合理的调度方式和参数
- 只返回 JSON，不要任何解释`;

export function registerCronHandlers(): void {
  ipcMain.handle(IPC_DOMAINS.CRON, async (_event, request: IPCRequest) => {
    const { action, payload } = request;
    const cronService = getCronService();

    try {
      switch (action) {
        case 'listJobs': {
          const { filter } = (payload || {}) as { filter?: { enabled?: boolean; tags?: string[] } };
          const jobs = cronService.listJobs(filter);
          return { success: true, data: jobs } satisfies IPCResponse;
        }

        case 'createJob': {
          const job = await cronService.createJob(payload as any);
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'updateJob': {
          const { jobId, updates } = payload as { jobId: string; updates: any };
          const job = await cronService.updateJob(jobId, updates);
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'deleteJob': {
          const { jobId } = payload as { jobId: string };
          const result = await cronService.deleteJob(jobId);
          return { success: true, data: result } satisfies IPCResponse;
        }

        case 'triggerJob': {
          const { jobId } = payload as { jobId: string };
          const execution = await cronService.triggerJob(jobId);
          return { success: true, data: execution } satisfies IPCResponse;
        }

        case 'getExecutions': {
          const { jobId, limit } = payload as { jobId: string; limit?: number };
          const executions = cronService.getJobExecutions(jobId, limit);
          return { success: true, data: executions } satisfies IPCResponse;
        }

        case 'getStats': {
          const stats = cronService.getStats();
          return { success: true, data: stats } satisfies IPCResponse;
        }

        case 'generateFromPrompt': {
          const { prompt } = payload as { prompt: string };
          if (!prompt?.trim()) {
            return { success: false, error: { code: 'INVALID_INPUT', message: '请输入任务描述' } } satisfies IPCResponse;
          }
          const router = new ModelRouter();
          const response = await router.chat({
            provider: 'zhipu',
            model: 'glm-4-flash',
            messages: [
              { role: 'system', content: CRON_GENERATION_SYSTEM_PROMPT },
              { role: 'user', content: prompt.trim() },
            ],
            maxTokens: 1024,
          });
          const raw = response.content || '';
          const jsonMatch = raw.match(/\{[\s\S]*\}/);
          if (!jsonMatch) {
            return { success: false, error: { code: 'PARSE_ERROR', message: 'AI 返回格式异常，请重试或换个描述方式' } } satisfies IPCResponse;
          }
          try {
            const draft = JSON.parse(jsonMatch[0]);
            return { success: true, data: draft } satisfies IPCResponse;
          } catch {
            return { success: false, error: { code: 'PARSE_ERROR', message: 'AI 返回的 JSON 解析失败，请重试' } } satisfies IPCResponse;
          }
        }

        default:
          return {
            success: false,
            error: { code: 'UNKNOWN_ACTION', message: `Unknown cron action: ${action}` },
          } satisfies IPCResponse;
      }
    } catch (error) {
      logger.error('Cron IPC error:', error);
      return {
        success: false,
        error: { code: 'CRON_ERROR', message: error instanceof Error ? error.message : 'Unknown error' },
      } satisfies IPCResponse;
    }
  });
}
