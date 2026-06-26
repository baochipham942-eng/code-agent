import type {
  AgentEngineFailureDiagnostics,
  AgentEngineKind,
} from '../../../shared/contract/agentEngine';

function firstStatusCode(message: string): number | undefined {
  const match = message.match(/\b(401|403|404|408|409|423|429|500|502|503|504)\b/);
  return match ? Number(match[1]) : undefined;
}

export function classifyAgentEngineFailure(args: {
  engine: AgentEngineKind;
  message: string;
  exitCode?: number | null;
  statusCode?: number;
  occurredAt?: number;
  timeout?: boolean;
  spawnError?: boolean;
}): AgentEngineFailureDiagnostics {
  const message = args.message.trim();
  const normalized = message.toLowerCase();
  const statusCode = typeof args.statusCode === 'number' && Number.isFinite(args.statusCode)
    ? args.statusCode
    : firstStatusCode(message);
  const occurredAt = typeof args.occurredAt === 'number' && Number.isFinite(args.occurredAt)
    ? args.occurredAt
    : Date.now();
  const base = {
    message,
    occurredAt,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
    ...(args.exitCode !== undefined ? { exitCode: args.exitCode } : {}),
  };

  if (args.timeout || normalized.includes('timed out') || normalized.includes('timeout')) {
    return {
      ...base,
      category: 'timeout',
      reason: 'timeout',
      suggestion: '外部 engine 超时。可以稍后重试，或切回 Native 主任务模型完成本轮任务。',
      retryable: true,
    };
  }

  if (
    statusCode === 401 ||
    normalized.includes('authentication_failed') ||
    normalized.includes('failed to authenticate') ||
    normalized.includes('invalid authentication credentials') ||
    normalized.includes('unauthorized') ||
    normalized.includes('needs login') ||
    normalized.includes('not logged in')
  ) {
    return {
      ...base,
      category: 'auth',
      reason: 'auth_failed',
      suggestion: args.engine === 'claude_code'
        ? 'Claude Code 认证失败。请完成 Claude CLI 登录或检查订阅/API 凭据后重试。'
        : 'Codex CLI 认证失败。请检查 CLI 登录状态或模型凭据后重试。',
      retryable: false,
      reliability: { authState: 'needs_login' },
    };
  }

  if (
    statusCode === 429 ||
    normalized.includes('rate limit') ||
    normalized.includes('too many requests') ||
    normalized.includes('quota') ||
    normalized.includes('credit') ||
    normalized.includes('billing')
  ) {
    const exhausted = normalized.includes('exhaust') || normalized.includes('insufficient') || normalized.includes('credit');
    return {
      ...base,
      category: 'quota',
      reason: exhausted ? 'quota_exhausted' : 'rate_limited',
      suggestion: exhausted
        ? '外部 engine 的额度或账单状态不可用。请换模型、换 provider，或补足额度后重试。'
        : '外部 engine 正在限流。可以稍后重试，或先切换到其他可用模型。',
      retryable: !exhausted,
      reliability: { quotaState: exhausted ? 'exhausted' : 'limited' },
    };
  }

  if (
    normalized.includes('econnrefused') ||
    normalized.includes('econnreset') ||
    normalized.includes('enotfound') ||
    normalized.includes('network') ||
    normalized.includes('fetch failed') ||
    statusCode === 502 ||
    statusCode === 503 ||
    statusCode === 504
  ) {
    return {
      ...base,
      category: 'network',
      reason: 'network_error',
      suggestion: '外部 engine 网络请求失败。请检查代理、网络或 CLI 服务状态后重试。',
      retryable: true,
    };
  }

  if (
    statusCode === 403 ||
    normalized.includes('permission denied') ||
    normalized.includes('forbidden') ||
    normalized.includes('not allowed')
  ) {
    return {
      ...base,
      category: 'permission',
      reason: 'permission_denied',
      suggestion: '外部 engine 权限不足。请检查账号模型权限、工作目录权限或 CLI 权限模式。',
      retryable: false,
    };
  }

  if (
    args.spawnError ||
    normalized.includes('command not found') ||
    normalized.includes('enoent') ||
    normalized.includes('not found on path')
  ) {
    return {
      ...base,
      category: 'missing_cli',
      reason: 'cli_unavailable',
      suggestion: '外部 CLI 不可用。请检查 CLI 是否安装、PATH 是否正确，或切回 Native 主任务模型。',
      retryable: false,
      reliability: { cliStatus: 'missing' },
    };
  }

  if (typeof args.exitCode === 'number' && args.exitCode !== 0) {
    return {
      ...base,
      category: 'runtime',
      reason: 'non_zero_exit',
      suggestion: '外部 engine 进程异常退出。请查看运行日志，或切回 Native 主任务模型重试。',
      retryable: false,
    };
  }

  return {
    ...base,
    category: 'unknown',
    reason: 'unknown_failure',
    suggestion: '外部 engine 失败原因未能自动归类。请查看日志或换用其他模型链路。',
    retryable: false,
  };
}

export function formatAgentEngineFailureContent(
  engineLabel: string,
  failure: AgentEngineFailureDiagnostics,
  logPath?: string,
): string {
  return [
    `**${engineLabel} 运行失败**`,
    '',
    failure.message,
    '',
    `建议：${failure.suggestion}`,
    logPath ? `日志：${logPath}` : null,
  ].filter((line): line is string => line !== null).join('\n');
}
