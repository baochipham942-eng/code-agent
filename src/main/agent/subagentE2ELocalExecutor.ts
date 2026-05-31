import { setTimeout as delay } from 'timers/promises';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import type { AgentMessage } from './spawnGuard';
import type { SubagentConfig, SubagentContext, SubagentResult } from './subagentExecutorTypes';

export function shouldUseE2ELocalSubagentExecutor(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_E2E === '1' && env.CODE_AGENT_E2E_LOCAL_SUBAGENT_EXECUTOR === '1';
}

function getE2ELocalSubagentDelayMs(env: NodeJS.ProcessEnv = process.env): number {
  const parsed = Number(env.CODE_AGENT_E2E_LOCAL_SUBAGENT_DELAY_MS);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.min(parsed, 5_000) : 80;
}

function formatAgentMessages(messages: AgentMessage[]): string {
  return messages
    .map((message) => `${message.from}:${String(message.payload)}`)
    .join(' | ');
}

export async function executeE2ELocalSubagent(
  prompt: string,
  config: SubagentConfig,
  context: SubagentContext,
): Promise<SubagentResult> {
  const received: AgentMessage[] = [];
  const collectMessages = (): void => {
    received.push(...(context.messageDrain?.() ?? []));
  };
  const startedAt = Date.now();
  const delayMs = getE2ELocalSubagentDelayMs();

  while (Date.now() - startedAt < delayMs) {
    collectMessages();
    if (context.abortSignal?.aborted) {
      const reason = normalizeCancellationReason(context.abortSignal.reason, 'parent-cancel');
      return {
        success: false,
        output: formatAgentMessages(received),
        error: `任务已取消 (${reason})`,
        toolsUsed: [],
        iterations: 1,
        cost: 0,
        cancellationReason: reason,
      };
    }
    await delay(Math.min(25, Math.max(1, delayMs - (Date.now() - startedAt))));
  }
  collectMessages();

  if (/E2E_FAIL/i.test(prompt)) {
    return {
      success: false,
      output: '',
      error: `E2E local subagent failed: ${config.name}`,
      toolsUsed: [],
      iterations: 1,
      cost: 0,
    };
  }

  return {
    success: true,
    output: [
      `E2E local subagent ${config.name} completed.`,
      `Prompt: ${prompt.slice(0, 120)}`,
      received.length > 0 ? `Messages: ${formatAgentMessages(received)}` : 'Messages: none',
    ].join('\n'),
    toolsUsed: [],
    iterations: 1,
    cost: 0,
  };
}
