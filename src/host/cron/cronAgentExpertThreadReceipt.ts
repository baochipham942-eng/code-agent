import type {
  CronJobDefinition,
  Message,
  SessionAutomationType,
} from '../../shared/contract';
import { IPC_CHANNELS } from '../../shared/ipc';
import { broadcastToRenderer } from '../platform';
import { getSessionManager } from '../services/infra/sessionManager';

const RECEIPT_SUMMARY_MAX_CHARS = 1_200;
const RECEIPT_ERROR_MAX_CHARS = 240;

type CronExpertThreadReceiptInput = {
  definition: Pick<CronJobDefinition, 'id' | 'name'>;
  roleId: string;
  cronSessionId: string;
  executionId?: string;
  startedAt: number;
  succeeded: boolean;
  finalAssistantText: string;
  error?: unknown;
  automationType: SessionAutomationType;
  workingDirectory?: string;
};

function truncateText(value: string, maxChars: number): string {
  const chars = Array.from(value.trim());
  if (chars.length <= maxChars) return chars.join('');
  return `${chars.slice(0, maxChars).join('').trimEnd()}…`;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return error == null ? '' : String(error);
}

function formatReceiptContent(input: CronExpertThreadReceiptInput): string {
  const ranAt = new Date(input.startedAt).toLocaleString('zh-CN');
  const summary = truncateText(input.finalAssistantText, RECEIPT_SUMMARY_MAX_CHARS);
  const failure = truncateText(errorText(input.error), RECEIPT_ERROR_MAX_CHARS);
  const resultLine = input.succeeded
    ? '结果：成功。'
    : `结果：失败${failure ? `（${failure}）` : ''}。`;
  const conclusion = summary || (input.succeeded
    ? '这次运行没有生成可读结论。'
    : '这次运行失败前没有留下可读结论。');

  return [
    `定时任务「${input.definition.name}」已于 ${ranAt} 运行。`,
    resultLine,
    '',
    '这次的结论：',
    conclusion,
    '',
    `[查看这次运行的全过程（会话 ${input.cronSessionId}）](neo://thread/${input.cronSessionId})`,
  ].join('\n');
}

async function createExpertThread(input: CronExpertThreadReceiptInput): Promise<string> {
  const sessionManager = getSessionManager();
  const [{ SessionLifecycleAppService }, { getTaskManager }, { getConfigService }] = await Promise.all([
    import('../app/sessionLifecycleAppService'),
    import('../task'),
    import('../services/core/configService'),
  ]);
  const lifecycle = new SessionLifecycleAppService({
    getTaskManager,
    getConfigService,
    getCurrentSessionId: () => sessionManager.getCurrentSessionId(),
    setCurrentSessionId: (sessionId) => sessionManager.setCurrentSession(sessionId),
    getWorkingDirectory: () => input.workingDirectory,
  });
  await lifecycle.createSession({
    title: input.roleId,
    workingDirectory: input.workingDirectory,
    expertRoleId: input.roleId,
    activate: false,
  });

  // createSession 的 marker 持久化保持兼容性的 non-blocking 语义；cron 回灌必须确认
  // SQL 真能找回这条 thread，否则消息没有稳定归宿，应交给上层 fail-loud。
  const persisted = await sessionManager.findLatestExpertThreadSession(input.roleId);
  if (!persisted) {
    throw new Error(`expert thread was created but its role marker is not queryable (roleId=${input.roleId})`);
  }
  return persisted.id;
}

/** 将具名角色 cron 的终态收据写进该角色唯一的常驻 thread。 */
export async function appendCronAgentExpertThreadReceipt(
  input: CronExpertThreadReceiptInput,
): Promise<{ expertThreadSessionId: string }> {
  const sessionManager = getSessionManager();
  const existing = await sessionManager.findLatestExpertThreadSession(input.roleId);
  const expertThreadSessionId = existing?.id ?? await createExpertThread(input);
  const message: Message = {
    id: `cron-expert-receipt:${input.executionId ?? input.cronSessionId}`,
    role: 'assistant',
    source: 'automation',
    content: formatReceiptContent(input),
    timestamp: Date.now(),
    metadata: {
      automation: {
        automationId: `${input.automationType}:${input.definition.id}`,
        automationType: input.automationType,
        event: input.succeeded ? 'completed' : 'failed',
        sourceSessionId: expertThreadSessionId,
        sourceRefId: input.definition.id,
        resultSessionId: input.cronSessionId,
        status: input.succeeded ? 'completed' : 'failed',
        title: input.definition.name,
        lastRunAt: input.startedAt,
      },
    },
  };

  await sessionManager.addMessageToSession(expertThreadSessionId, message);
  try {
    broadcastToRenderer(IPC_CHANNELS.SESSION_AUTOMATION_MESSAGE, {
      sessionId: expertThreadSessionId,
      message,
    });
  } catch {
    // DB 是真源；renderer 未激活时会在下次打开 thread 时加载这条收据。
  }
  return { expertThreadSessionId };
}
