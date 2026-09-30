const SANDBOX_DENIAL_PATTERN = /\bEPERM\b|Operation not permitted/i;

export function extractSandboxDeniedPath(failureText: string): string | undefined {
  const nodeErrorPath = /\bEPERM\b[^\r\n]*?\b(?:open|mkdir|unlink|rename|scandir|stat|lstat|access|chmod|chown)\s+['"]([^'"\r\n]+)['"]/i.exec(failureText)?.[1];
  if (nodeErrorPath) return nodeErrorPath;

  const npmErrorPath = /(?:^|\n)(?:npm (?:error|ERR!)\s+)?path\s+([^\r\n]+)/im.exec(failureText)?.[1]?.trim();
  if (npmErrorPath) return npmErrorPath;

  return /(?:^|\n)[^:\r\n]+:\s+((?:~|\/)[^:\r\n]+):\s+Operation not permitted\b/im.exec(failureText)?.[1]?.trim();
}

export function diagnoseSandboxDenial(input: {
  failureText: string;
  sandboxed?: boolean;
  workingDirectory?: string;
}): string | undefined {
  if (!input.sandboxed || !SANDBOX_DENIAL_PATTERN.test(input.failureText)) return undefined;

  const deniedPath = extractSandboxDeniedPath(input.failureText);
  return deniedPath
    ? `沙盒拒绝：${deniedPath}（沙盒只允许写 ${input.workingDirectory ?? '工作目录'} 与临时目录）`
    : '沙盒拒绝了工作目录外的写入';
}

export interface BashFailureDiagnosticsInput {
  command: string;
  message?: string;
  stdout?: string;
  stderr?: string;
  signal?: NodeJS.Signals | null;
  code?: number | string | null;
  durationMs?: number;
  sandboxed?: boolean;
  workingDirectory?: string;
}

const SELF_KILL_SIGNALS = new Set<NodeJS.Signals>(['SIGTERM', 'SIGKILL']);
const KILL_COMMAND_PATTERN = /\b(?:pkill|killall|kill)\b/;
const NODE_TOOL_PATTERN = /\b(npx|node|npm)\b/;
const MISSING_COMMAND_PATTERN = /\bENOENT\b|command not found|not found/i;

export function diagnoseBashFailure(input: BashFailureDiagnosticsInput): string[] {
  const diagnostics: string[] = [];
  const signal = input.signal ?? undefined;
  const durationMs = input.durationMs ?? Number.POSITIVE_INFINITY;

  if (
    signal
    && SELF_KILL_SIGNALS.has(signal)
    && durationMs < 1000
    && KILL_COMMAND_PATTERN.test(input.command)
  ) {
    diagnostics.push(
      '诊断：命令可能用 kill/pkill/killall 终止了当前 shell 进程；如果目标是清理其他进程，请避免匹配当前 bash，或改用更精确的 PID。',
    );
  }

  const nodeTool = input.command.match(NODE_TOOL_PATTERN)?.[1];
  const failureText = [input.message, input.stdout, input.stderr].filter(Boolean).join('\n');

  const sandboxDenial = diagnoseSandboxDenial({
    failureText,
    sandboxed: input.sandboxed,
    workingDirectory: input.workingDirectory,
  });
  if (sandboxDenial) diagnostics.push(sandboxDenial);

  if (nodeTool && MISSING_COMMAND_PATTERN.test(failureText)) {
    diagnostics.push(
      `诊断：${nodeTool} 启动失败，可能是 Node.js 依赖或可执行文件缺失（ENOENT / command not found）。建议先确认依赖已安装，并检查 PATH / node_modules。`,
    );
  }

  if (String(input.code) === '137') {
    diagnostics.push(
      '诊断：exit 137 通常表示进程可能被系统 OOM killer 终止（内存不足）。建议降低并发、减少构建规模，或改用后台任务观察输出。',
    );
  }

  return diagnostics;
}

export function appendFailureDiagnostics(message: string, diagnostics: string[]): string {
  if (diagnostics.length === 0) return message;
  return `${message}\n\n${diagnostics.join('\n')}`;
}
