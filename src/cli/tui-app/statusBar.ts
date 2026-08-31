// ============================================================================
// StatusBar 文案（Grok 式左右分栏）：左权限+模型+供应商+分支，右 token/ctx/成本。
// 纯函数，可单测。
// ============================================================================

function ctxBar(percent: number): string {
  const filled = Math.round((Math.min(percent, 100) / 100) * 5);
  return '▓'.repeat(filled) + '░'.repeat(5 - filled);
}

export function formatStatusBar(input: {
  permissionLabel: string;
  model: string;
  provider: string;
  gitBranch: string;
  gitDirty?: boolean;
  inputTokens: number;
  outputTokens: number;
  contextPercent: number | null;
  costUsd: number;
}): { left: string; right: string } {
  const branch = input.gitBranch
    ? `${input.gitBranch}${input.gitDirty ? '*' : ''}`
    : '';
  const left = [
    input.permissionLabel,
    input.model,
    input.provider ? `(${input.provider})` : '',
    branch,
  ].filter(Boolean).join('  ');
  const right = [
    input.inputTokens + input.outputTokens > 0
      ? `⇡${input.inputTokens} ⇣${input.outputTokens}`
      : '',
    input.contextPercent != null
      ? `ctx ${ctxBar(input.contextPercent)} ${input.contextPercent.toFixed(0)}%`
      : '',
    input.costUsd > 0 ? `$${input.costUsd.toFixed(4)}` : '',
  ].filter(Boolean).join('  ');
  return { left, right };
}
