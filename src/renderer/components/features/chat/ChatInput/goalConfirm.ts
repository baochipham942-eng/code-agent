// ============================================================================
// /goal 确认卡辅助逻辑
// ----------------------------------------------------------------------------
// 主路径：/goal <自然语言> → 确认卡（提炼结果 + 一键启动）→ startGoalRun。
// 显式 flags（--verify / --review / 预算类）视为 power-user 合同，跳过确认卡。
// 验证命令候选只来自项目真实 package.json scripts（fail-closed：绝不由模型或
// 规则编造可执行命令），常驻类脚本（dev/serve/watch）排除以免挂死验证闸。
// ============================================================================

import type { ParsedGoalCommand } from './parseGoalCommand';

/** 显式合同字段任一存在 → 直接启动，不走确认卡 */
export function shouldOpenGoalConfirm(parsed: ParsedGoalCommand | null | undefined): boolean {
  if (!parsed || !parsed.goal?.trim()) return true;
  const hasExplicitContract =
    parsed.verify !== undefined
    || parsed.review !== undefined
    || parsed.maxTurns !== undefined
    || parsed.budget !== undefined
    || parsed.wallClockBudgetMs !== undefined;
  return !hasExplicitContract;
}

/** 验证类脚本优先级（越靠前越优先） */
const PREFERRED_SCRIPT_ORDER = ['typecheck', 'test', 'lint', 'build', 'check'];

/** 常驻/交互类脚本：跑不完，进验证闸只会超时 */
const LONG_RUNNING_SCRIPT_PATTERN = /^(dev|start|serve|preview|storybook)([.:_-]|$)|^watch([.:_-]|$)/;

export const MAX_VERIFY_CANDIDATES = 6;

/**
 * 从 package.json 原文提取验证命令候选。
 * 返回可直接执行的完整命令（`npm test` / `npm run <name>`）。
 * 读不到 / 坏 JSON / 无 scripts → 空数组。
 */
export function buildVerifyCandidates(packageJsonRaw: string | null | undefined): string[] {
  if (!packageJsonRaw) return [];
  let scripts: Record<string, unknown>;
  try {
    const parsed = JSON.parse(packageJsonRaw) as { scripts?: Record<string, unknown> };
    if (!parsed || typeof parsed !== 'object' || !parsed.scripts || typeof parsed.scripts !== 'object') {
      return [];
    }
    scripts = parsed.scripts;
  } catch {
    return [];
  }

  const names = Object.keys(scripts)
    .filter((name) => typeof scripts[name] === 'string' && name.trim().length > 0)
    .filter((name) => !LONG_RUNNING_SCRIPT_PATTERN.test(name));

  const rank = (name: string): number => {
    const idx = PREFERRED_SCRIPT_ORDER.indexOf(name);
    return idx === -1 ? PREFERRED_SCRIPT_ORDER.length : idx;
  };
  names.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));

  return names
    .slice(0, MAX_VERIFY_CANDIDATES)
    .map((name) => (name === 'test' ? 'npm test' : `npm run ${name}`));
}
