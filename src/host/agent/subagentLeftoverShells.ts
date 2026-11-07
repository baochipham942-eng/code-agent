import {
  formatSubagentLeftoverShellReport,
  type SubagentLeftoverShellReportItem,
} from '../../shared/i18n/subagentLeftoverShells';
import type { SessionTaskSlotLocale } from '../../shared/i18n/sessionTaskSlot';
import { getConfigService } from '../services/core/configService';
import { createLogger } from '../services/infra/logger';
import { commandMayAwaitSystemPrompt } from '../task/macosAutomationPrompt';
import {
  getAllBackgroundTasks,
  getBackgroundTaskPid,
} from '../tools/modules/shell/backgroundTaskLedger';

const logger = createLogger('SubagentLeftoverShells');
const MAX_COMMAND_SUMMARY_LENGTH = 80;

export type SubagentShellExitReason = 'completed' | 'cancelled' | 'failed' | 'early-failure';

function commandSummary(command: string): string {
  const compact = command.replace(/\s+/g, ' ').trim().replace(/`/g, "'");
  if (compact.length <= MAX_COMMAND_SUMMARY_LENGTH) return compact;
  return `${compact.slice(0, MAX_COMMAND_SUMMARY_LENGTH - 1)}…`;
}

function resolveLocale(executionAgentId: string): SessionTaskSlotLocale {
  try {
    return getConfigService().getSettings().ui.language;
  } catch (error) {
    logger.warn('Failed to read UI locale for leftover shell report; using Chinese fallback', {
      agentId: executionAgentId,
      message: error instanceof Error ? error.message : String(error),
    });
    return 'zh';
  }
}

export function reportSubagentLeftoverShells(
  executionAgentId: string,
  reason: SubagentShellExitReason,
): string {
  const tasks = getAllBackgroundTasks().filter(
    (task) => task.status === 'running' && task.ownerAgentId === executionAgentId,
  );
  if (tasks.length === 0) return '';
  const items: SubagentLeftoverShellReportItem[] = tasks.map((task) => {
    const reportCommand = task.displayCommand ?? task.command;
    logger.warn('Subagent ended with a background shell still running', {
      agentId: executionAgentId,
      taskId: task.taskId,
      pid: getBackgroundTaskPid(task.taskId),
      reason,
    });
    return {
      commandSummary: commandSummary(reportCommand),
      taskId: task.taskId,
      elapsedMs: task.duration,
      mayAwaitSystemPrompt: commandMayAwaitSystemPrompt(reportCommand),
    };
  });
  return formatSubagentLeftoverShellReport(items, resolveLocale(executionAgentId));
}

export function appendSubagentLeftoverShellReport(text: string, report: string): string {
  if (!report) return text;
  return text ? `${text}\n\n${report}` : report;
}

export function appendSubagentLeftoverShellReportToError(error: unknown, report: string): unknown {
  if (!report) return error;
  const existingMessage = error instanceof Error ? error.message : String(error);
  const message = appendSubagentLeftoverShellReport(existingMessage, report);
  if (error instanceof Error) {
    try {
      error.message = message;
      return error;
    } catch {
      const wrapped = new Error(message, { cause: error });
      wrapped.name = error.name;
      return wrapped;
    }
  }
  return new Error(message);
}
