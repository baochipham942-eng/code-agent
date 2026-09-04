import type { DecisionStep } from '../../shared/contract/decisionTrace';
import { createTraceStep } from '../security/decisionTraceBuilder';
import { parseShellCommand, type ShellExecution } from '../security/commandParse';

interface ImmediateAsk {
  decision: 'ask';
  reason: string;
  confidence: number;
  cached: false;
  riskUnknown?: true;
  traceStep: DecisionStep;
}

interface PermissionCommandInspection {
  execution?: ShellExecution;
  outputRedirectionAsk?: ImmediateAsk;
  parseFailureAsk?: ImmediateAsk;
  packageManager: boolean;
  changeDirectory: boolean;
}

const PACKAGE_MANAGER_PROGRAMS = new Set(['npm', 'npx', 'pnpm', 'yarn']);

export function inspectPermissionCommand(command: string, startTime: number): PermissionCommandInspection {
  const parsed = parseShellCommand(command);
  const execution = parsed.executions.length === 1 ? parsed.executions[0] : undefined;
  const parseDetail = parsed.parsingFailed || parsed.uncertain.length > 0
    ? parsed.failureReason ?? parsed.uncertain.join(', ')
    : undefined;
  const parseReason = parseDetail ? `命令无法可靠解析: ${parseDetail}` : undefined;
  const redirectReason = parsed.writeTargets.some((target) =>
    target.source === 'redirect' && target.path !== '/dev/null')
    ? '命令包含文件输出重定向，需要用户确认'
    : undefined;
  return {
    execution,
    packageManager: Boolean(execution && PACKAGE_MANAGER_PROGRAMS.has(execution.program)),
    changeDirectory: execution?.program === 'cd',
    ...(redirectReason ? {
      outputRedirectionAsk: {
        decision: 'ask', reason: redirectReason, confidence: 1, cached: false,
        traceStep: createTraceStep(
          'permission_classifier', 'B1: output_redirection', 'ask', redirectReason, startTime,
        ),
      },
    } : {}),
    ...(parseReason ? {
      parseFailureAsk: {
        decision: 'ask', reason: parseReason, confidence: 1, cached: false, riskUnknown: true,
        traceStep: createTraceStep(
          'permission_classifier', 'B0: shared_shell_parse', 'ask', parseReason, startTime,
        ),
      },
    } : {}),
  };
}
