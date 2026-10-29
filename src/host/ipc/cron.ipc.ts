// ============================================================================
// Cron IPC Handlers
// ============================================================================

import { ipcHost } from '../platform';
import type { IPCResponse } from '../../shared/ipc';
import type { RawDomainRouteHandlers } from '../../shared/ipc/domainRoutes';
import { CronSchemas, type CronDomainRequest } from '../../shared/ipc/schemas/cron';
import { defineDomainRoutes, installDomainRoutes } from './domainRoutes/registry';
import { getCronService } from '../cron/cronService';
import { CloudNotConfiguredError } from '../cron/cronWebhookRelay';
import { getConnectorRegistry } from '../connectors/registry';
import { ModelRouter } from '../model/modelRouter';
import { createLogger } from '../services/infra/logger';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import type { CreateCronJobDefinition, CronJobDefinition, CronMailSourcesResult } from '../../shared/contract/cron';

const logger = createLogger('CronIPC');

type CreateCronJobPayload = CreateCronJobDefinition;
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
  // runCount 是只读结算字段（contract/cron.ts）：外部传入一律丢弃，不许借创建重置计数。
  const { runCount: _droppedRunCount, ...payload } = source;
  return payload as unknown as CreateCronJobPayload;
}

function getUpdateCronJobRequest(source: unknown): { jobId: string; updates: UpdateCronJobPayload } {
  if (!isRecord(source)) throw new Error('Invalid cron job update payload');
  const jobId = getStringField(source, 'jobId');
  const updates = source.updates;
  if (!jobId || !isRecord(updates)) throw new Error('Invalid cron job update payload');
  // 同上：外部不许借更新改写 runCount；内部结算走 CronService 自己的窄写通道。
  const { runCount: _droppedRunCount, ...restUpdates } = updates;
  return { jobId, updates: restUpdates as unknown as UpdateCronJobPayload };
}

/**
 * 列出 mail 触发源可绑定的账号与邮箱（N-TRIGGER-MAIL-CREATE-ENTRY-K1）。失败分类
 * 与 cronMailPoller 的 createDefaultMailReader 同构：未注册（设置里没启用）=
 * connector-not-enabled；探测不过（未授权/授权被拒）= not-authorized；readiness
 * unavailable（非 macOS）= unsupported-platform；list_accounts 抛错 = read-error。
 * readiness 非 ready 时先补一次 probe_access（重启后 readiness 回 unchecked，已授权
 * 用户不该被逼去设置再点一次）。每个非 ok 分支都带 reason 记日志（降级留痕）。
 */
async function listMailSources(): Promise<CronMailSourcesResult> {
  const mailConnector = getConnectorRegistry().get('mail');
  if (!mailConnector) {
    logger.warn('listMailSources unavailable (reason: connector-not-enabled): mail connector is not registered');
    return { ok: false, reason: 'connector-not-enabled' };
  }
  const readiness = mailConnector.getCachedStatus?.().readiness;
  if (readiness === 'unavailable') {
    logger.warn('listMailSources unavailable (reason: unsupported-platform): mail connector reports unavailable');
    return { ok: false, reason: 'unsupported-platform' };
  }
  if (readiness !== 'ready') {
    try {
      await mailConnector.execute('probe_access', {});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logger.warn(`listMailSources unavailable (reason: not-authorized, cached readiness: ${readiness ?? 'unknown'}): ${detail}`);
      return { ok: false, reason: 'not-authorized', detail };
    }
  }
  try {
    const accountsResult = await mailConnector.execute('list_accounts', {});
    const accounts = (Array.isArray(accountsResult.data) ? accountsResult.data : [])
      .filter((item): item is { name: string } => isRecord(item) && typeof item.name === 'string' && item.name.trim() !== '')
      .map((item) => ({ name: item.name }));
    const mailboxesByAccount: Record<string, string[]> = {};
    for (const account of accounts) {
      try {
        const mailboxesResult = await mailConnector.execute('list_mailboxes', { account: account.name });
        const rawMailboxes = Array.isArray(mailboxesResult.data) ? mailboxesResult.data : [];
        const mailboxes = rawMailboxes
          .filter((item): item is { account: string; name: string } =>
            isRecord(item) && typeof item.name === 'string' && item.name.trim() !== '')
          // list_mailboxes 不带 account 过滤时返回所有账户的邮箱，按 account 字段收窄。
          .filter((item) => !item.account || item.account === account.name)
          .map((item) => item.name);
        mailboxesByAccount[account.name] = mailboxes;
      } catch (error) {
        // 单账户邮箱列举失败不拖死整个目录：该账户降级为空列表（UI 回落默认 INBOX），
        // 其余账户照常；失败原因记日志可区分。
        const detail = error instanceof Error ? error.message : String(error);
        logger.warn(`listMailSources mailbox listing failed for account ${account.name}: ${detail}`);
        mailboxesByAccount[account.name] = [];
      }
    }
    return { ok: true, accounts, mailboxesByAccount };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.warn(`listMailSources unavailable (reason: read-error): ${detail}`);
    return { ok: false, reason: 'read-error', detail };
  }
}

/**
 * webhook hook 注册/轮换。{url, token} 只在成功响应的 data 里出现一次；失败分支
 * 只带不含密钥的主机消息（失败时本就没有密钥），云端未配置用独立 code 供渲染层本地化。
 */
async function runWebhookHookAction(operation: 'register' | 'rotate', payload: unknown): Promise<IPCResponse> {
  const jobId = getStringField(payload, 'jobId');
  if (!jobId) throw new Error('Invalid cron job id');
  const cronService = getCronService();
  try {
    const secret = operation === 'register'
      ? await cronService.registerWebhookHook(jobId)
      : await cronService.rotateWebhookHook(jobId);
    return { success: true, data: secret };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`Cron webhook hook ${operation} failed for job ${jobId}: ${message}`);
    return {
      success: false,
      error: { code: error instanceof CloudNotConfiguredError ? 'CRON_CLOUD_NOT_CONFIGURED' : 'CRON_ERROR', message },
    };
  }
}

const CRON_GENERATION_SYSTEM_PROMPT = `你是一个定时任务配置助手。根据用户的自然语言描述，生成定时任务的 JSON 配置。

只返回一个 JSON 对象，不要有其他文字。JSON 格式如下：

{
  "name": "任务名称",
  "description": "任务描述",
  "enabled": true,
  "scheduleType": "every" | "cron" | "at" | "event",
  "schedule": {
    // every 类型: { "type": "every", "interval": 数字, "unit": "seconds"|"minutes"|"hours"|"days" }
    // cron 类型: { "type": "cron", "expression": "cron表达式", "timezone": "Asia/Shanghai" }
    // at 类型: { "type": "at", "datetime": "ISO时间字符串" }
    // event 类型: { "type": "event", "source": "channel", "eventName": "message" }
    //   或邮件监听: { "type": "event", "source": "connector", "connector": "mail", "eventName": "message" }
  },
  "action": {
    // agent 类型（最常用）: { "type": "agent", "agentType": "default", "prompt": "要让 AI 智能体执行的任务描述" }
    // shell 类型: { "type": "shell", "command": "命令" }
    // webhook 类型: { "type": "webhook", "url": "地址", "method": "POST", "headers": {}, "body": {} }
  },
  "tags": ["标签"],
  "maxRetries": 0,
  "timeout": null,
  "restatement": {
    "what": "用一句平实的话说明会检查什么",
    "notifyWhen": "用一句平实的话说明什么变化值得通知"
  }
}

注意：
- 动作类型判断：用户描述「让 AI 做某事」（调研/分析/写作/总结/巡检/汇报/监控并通知等需智能体执行的任务）→ 用 agent，把要执行的任务原样填进 prompt，agentType 填 "default"；只有明确是 shell 命令或脚本（如「运行 backup.sh」「执行 git pull」）才用 shell。多数自然语言任务应该用 agent。
- 时区默认 Asia/Shanghai
- 尽量从描述中推断合理的调度方式和参数
- 错峰：小时级/天级的循环任务避免落在整点（分钟=0）扎堆触发——除非用户明确要求整点，cron 表达式的分钟位默认用一个非 0 值（如 17），"every" 间隔类型不受影响（会自动错峰）
- 事件监听：用户想「盯着/监听某个群或会话，来了新消息就做某事」（如「关注发布群，有人提到发布就总结给我」「群里有消息就提醒我」）→ scheduleType 用 "event"，schedule 固定为 { "type": "event", "source": "channel", "eventName": "message" }，并在返回 JSON 顶层加 "groupName": 用户原话提到的群名（字符串；用户没点名具体群就省略这个字段）。不要编造 accountId 或 chatId——账号和群由用户稍后在确认卡里自己选。event 类型的动作必须是 agent。
- 邮件监听：用户说「有新邮件时/来新邮件就做某事」（如「新邮件到了把它整理成待办」）→ scheduleType 用 "event"，schedule 固定为 { "type": "event", "source": "connector", "connector": "mail", "eventName": "message" }。不要编造 accountId 或 mailbox——邮件账号和邮箱由用户稍后在确认卡里自己选。event 类型的动作必须是 agent。
- 可选地返回 restatement；其中 what 和 notifyWhen 都必须是面向用户的平实完整句子。若无法可靠推断，可省略整个 restatement 对象。
- 只返回 JSON，不要任何解释`;

/**
 * cron 域单源路由表（RQ-183 续作·CRON 刀）：原 domain switch 逐 case 平移为 handler（rawResponse：
 * handler 仍返回完整 IPCResponse，含 generateFromPrompt 的 INVALID_INPUT / PARSE_ERROR 失败响应，
 * 逐字不变）；每个 handler 按请求取 getCronService()（同原 switch 每请求取一次）；未知 action →
 * UNKNOWN_ACTION `Unknown cron action: <action>`；抛错 → CRON_ERROR + 同款日志。
 */
const cronHandlers: RawDomainRouteHandlers<CronDomainRequest, void> = {
  getGroupListenCheck: async (_ctx, payload) => {
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    return { success: true, data: getCronService().getGroupListenCheck(jobId) } satisfies IPCResponse;
  },
  startGroupListenCheck: async (_ctx, payload) => {
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    return { success: true, data: getCronService().getGroupListenCheck(jobId, true) } satisfies IPCResponse;
  },
  listJobs: async (_ctx, payload) => {
    const cronService = getCronService();
    const filter = getCronJobFilter(payload);
    const jobs = cronService.listJobs(filter);
    return { success: true, data: jobs } satisfies IPCResponse;
  },
  registerWebhookHook: async (_ctx, payload) => runWebhookHookAction('register', payload),
  rotateWebhookHook: async (_ctx, payload) => runWebhookHookAction('rotate', payload),
  ensureCloudStream: async () => {
    getCronService().ensureCloudStream();
    return { success: true } satisfies IPCResponse;
  },
  listMailSources: async () => {
    // 可用性结果（含 ok:false 的 reason 分类）走 success:true + data：这是结构化的
    // 「现在能不能选账号」陈述，不是 IPC 层错误；渲染层按 reason 给可区分提示。
    return { success: true, data: await listMailSources() } satisfies IPCResponse;
  },
  createJob: async (_ctx, payload) => {
    const cronService = getCronService();
    const job = await cronService.createJob(getCreateCronJobPayload(payload));
    return { success: true, data: job } satisfies IPCResponse;
  },
  updateJob: async (_ctx, payload) => {
    const cronService = getCronService();
    const { jobId, updates } = getUpdateCronJobRequest(payload);
    const job = await cronService.updateJob(jobId, updates);
    return { success: true, data: job } satisfies IPCResponse;
  },
  grantLoginPassThrough: async (_ctx, payload) => {
    const cronService = getCronService();
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    const siteOrigin = getStringField(payload, 'siteOrigin');
    if (!siteOrigin) throw new Error('Invalid cron login pass-through origin');
    const job = await cronService.grantLoginPassThrough(jobId, siteOrigin);
    return { success: true, data: job } satisfies IPCResponse;
  },
  deleteJob: async (_ctx, payload) => {
    const cronService = getCronService();
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    const result = await cronService.deleteJob(jobId);
    return { success: true, data: result } satisfies IPCResponse;
  },
  triggerJob: async (_ctx, payload) => {
    const cronService = getCronService();
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    const execution = await cronService.triggerJob(jobId);
    return { success: true, data: execution } satisfies IPCResponse;
  },
  getExecutions: async (_ctx, payload) => {
    const cronService = getCronService();
    const jobId = getStringField(payload, 'jobId');
    if (!jobId) throw new Error('Invalid cron job id');
    const limit = getNumberField(payload, 'limit');
    const executions = cronService.getJobExecutions(jobId, limit);
    return { success: true, data: executions } satisfies IPCResponse;
  },
  getRecentExecutions: async (_ctx, payload) => {
    const cronService = getCronService();
    const limit = getNumberField(payload, 'limit');
    const executions = cronService.getRecentExecutions(limit);
    return { success: true, data: executions } satisfies IPCResponse;
  },
  getStats: async (_ctx, _payload) => {
    const cronService = getCronService();
    const stats = cronService.getStats();
    return { success: true, data: stats } satisfies IPCResponse;
  },
  generateFromPrompt: async (_ctx, payload) => {
    const prompt = getStringField(payload, 'prompt');
    if (!prompt?.trim()) {
      return { success: false, error: { code: 'INVALID_INPUT', message: '请输入任务描述' } } satisfies IPCResponse;
    }
    const router = new ModelRouter();
    // 注入当前时间锚点：LLM 默认拿训练期日期，会把「明天/下周」算成过去时间，
    // 生成 at 类型任务静默不跑（艾克斯 in-app 验证抓到）。必须给当前时间做基准。
    const nowAnchor = `\n\n【当前时间】${new Date().toISOString()}（UTC，默认时区 Asia/Shanghai）。`
      + `用户用「今天/明天/今晚/本周/下周」等相对时间时，必须以此为基准换算成将来的绝对时间，`
      + `生成的 at 类型 datetime 绝不能早于当前时间。`;
    // 调用当下解析用户配置的默认 provider/model。没配过才落到出厂默认。
    const { provider, model } = resolveSessionDefaultModelConfig();
    const response = await router.chat({
      provider,
      model,
      messages: [
        { role: 'system', content: CRON_GENERATION_SYSTEM_PROMPT + nowAnchor },
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
  },
};

const cronRoutes = defineDomainRoutes<CronDomainRequest, void>(CronSchemas.REQUEST, cronHandlers, {
  rawResponse: true,
  unknownActionCode: 'UNKNOWN_ACTION',
  unknownActionMessage: (action) => `Unknown cron action: ${String(action)}`,
  mapError: (error) => {
    logger.error('Cron IPC error:', error);
    return { code: 'CRON_ERROR', message: error instanceof Error ? error.message : 'Unknown error' };
  },
});

export function registerCronHandlers(): void {
  installDomainRoutes(ipcHost, cronRoutes, undefined);
}

// 表挂装配函数对象上供 parity 门枚举（同 registerMemoryHandlers.routes 先例）
registerCronHandlers.routes = cronRoutes;
