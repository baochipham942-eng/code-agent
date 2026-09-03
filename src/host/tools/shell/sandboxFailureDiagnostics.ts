const SANDBOX_DENIAL_PATTERN = /\bEPERM\b|Operation not permitted/i;

function extractSandboxDeniedPath(failureText: string): string | undefined {
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
