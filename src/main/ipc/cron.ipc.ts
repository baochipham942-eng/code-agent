// ============================================================================
// Cron IPC Handlers
// ============================================================================

import { ipcMain } from '../platform';
import { IPC_DOMAINS, type IPCRequest, type IPCResponse } from '../../shared/ipc';
import { getCronService } from '../cron/cronService';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';
import { DEFAULT_MODELS } from '../../shared/constants';
import type { CronJobDefinition } from '../../shared/contract/cron';

const logger = createLogger('CronIPC');

type CreateCronJobPayload = Omit<CronJobDefinition, 'id' | 'createdAt' | 'updatedAt'>;
type UpdateCronJobPayload = Partial<Omit<CronJobDefinition, 'id' | 'createdAt'>>;
type CronJobFilterPayload = { enabled?: boolean; tags?: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getStringField(source: unknown, field: string): string | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'string' ? value : undefined;
}

function getNumberField(source: unknown, field: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const value = source[field];
  return typeof value === 'number' ? value : undefined;
}

function getCronJobFilter(source: unknown): CronJobFilterPayload | undefined {
  if (!isRecord(source)) return undefined;
  const filter = source.filter;
  if (!isRecord(filter)) return undefined;
  const result: CronJobFilterPayload = {};
  if (typeof filter.enabled === 'boolean') result.enabled = filter.enabled;
  if (Array.isArray(filter.tags) && filter.tags.every(tag => typeof tag === 'string')) {
    result.tags = filter.tags;
  }
  return result;
}

function getCreateCronJobPayload(source: unknown): CreateCronJobPayload {
  if (!isRecord(source)) throw new Error('Invalid cron job payload');
  return source as unknown as CreateCronJobPayload;
}

function getUpdateCronJobRequest(source: unknown): { jobId: string; updates: UpdateCronJobPayload } {
  if (!isRecord(source)) throw new Error('Invalid cron job update payload');
  const jobId = getStringField(source, 'jobId');
  const updates = source.updates;
  if (!jobId || !isRecord(updates)) throw new Error('Invalid cron job update payload');
  return { jobId, updates: updates as unknown as UpdateCronJobPayload };
}

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
    // agent 类型（最常用）: { "type": "agent", "agentType": "default", "prompt": "要让 AI 智能体执行的任务描述" }
    // shell 类型: { "type": "shell", "command": "命令" }
    // webhook 类型: { "type": "webhook", "url": "地址", "method": "POST", "headers": {}, "body": {} }
  },
  "tags": ["标签"],
  "maxRetries": 0,
  "timeout": null
}

注意：
- 动作类型判断：用户描述「让 AI 做某事」（调研/分析/写作/总结/巡检/汇报/监控并通知等需智能体执行的任务）→ 用 agent，把要执行的任务原样填进 prompt，agentType 填 "default"；只有明确是 shell 命令或脚本（如「运行 backup.sh」「执行 git pull」）才用 shell。多数自然语言任务应该用 agent。
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
          const filter = getCronJobFilter(payload);
          const jobs = cronService.listJobs(filter);
          return { success: true, data: jobs } satisfies IPCResponse;
        }

        case 'createJob': {
          const job = await cronService.createJob(getCreateCronJobPayload(payload));
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'updateJob': {
          const { jobId, updates } = getUpdateCronJobRequest(payload);
          const job = await cronService.updateJob(jobId, updates);
          return { success: true, data: job } satisfies IPCResponse;
        }

        case 'deleteJob': {
          const jobId = getStringField(payload, 'jobId');
          if (!jobId) throw new Error('Invalid cron job id');
          const result = await cronService.deleteJob(jobId);
          return { success: true, data: result } satisfies IPCResponse;
        }

        case 'triggerJob': {
          const jobId = getStringField(payload, 'jobId');
          if (!jobId) throw new Error('Invalid cron job id');
          const execution = await cronService.triggerJob(jobId);
          return { success: true, data: execution } satisfies IPCResponse;
        }

        case 'getExecutions': {
          const jobId = getStringField(payload, 'jobId');
          if (!jobId) throw new Error('Invalid cron job id');
          const limit = getNumberField(payload, 'limit');
          const executions = cronService.getJobExecutions(jobId, limit);
          return { success: true, data: executions } satisfies IPCResponse;
        }

        case 'getStats': {
          const stats = cronService.getStats();
          return { success: true, data: stats } satisfies IPCResponse;
        }

        case 'generateFromPrompt': {
          const prompt = getStringField(payload, 'prompt');
          if (!prompt?.trim()) {
            return { success: false, error: { code: 'INVALID_INPUT', message: '请输入任务描述' } } satisfies IPCResponse;
          }
          const router = new ModelRouter();
          const response = await router.chat({
            provider: 'zhipu',
            model: DEFAULT_MODELS.quick,
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
            const draft: unknown = JSON.parse(jsonMatch[0]);
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
