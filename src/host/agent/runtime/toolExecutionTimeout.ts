import { TOOL_PROGRESS } from '../../../shared/constants';

export function mcpServerForTool(toolName: string, args: Record<string, unknown> | undefined): string | undefined {
  const current = /^mcp__(.+?)__/i.exec(toolName)?.[1] ?? /^mcp_(.+?)_/i.exec(toolName)?.[1];
  if (current) return current;
  if (toolName.toLowerCase() === 'mcpunified' || toolName.toLowerCase() === 'mcp') {
    if (typeof args?.server === 'string') return args.server;
    if (typeof args?.serverName === 'string') return args.serverName;
  }
  return undefined;
}

export async function awaitToolExecutionWithTimeout<T>(
  execution: Promise<T>,
  options: {
    timeoutMs: number;
    getInactiveMs: () => number;
    abort: () => void;
    onTimeout: (elapsedMs: number) => void;
    buildTimeoutResult: (elapsedMs: number) => T;
  },
): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  return new Promise<T>((resolve, reject) => {
    timer = setInterval(() => {
      const inactiveMs = options.getInactiveMs();
      if (inactiveMs < options.timeoutMs) return;
      if (timer) clearInterval(timer);
      timer = undefined;
      options.abort();
      options.onTimeout(inactiveMs);
      resolve(options.buildTimeoutResult(inactiveMs));
    }, TOOL_PROGRESS.REPORT_INTERVAL);
    execution.then(resolve, reject);
  }).finally(() => {
    if (timer) clearInterval(timer);
  });
}
