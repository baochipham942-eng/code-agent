// ============================================================================
// About 页构建信息展示：BuildInfo → 一行可读文本（无可显示内容时为 null）
// branch / commitShort / builtAt 逐段判空拼接，缺哪段就整段不出现（FB-571）。
// ============================================================================

import type { BuildInfo } from '@shared/contract';
import type { Translations } from '../i18n';

/** builtAt 宿主侧只校验「是字符串」，可能不可解析；解析失败按缺失处理 */
function parseBuiltAt(builtAt: string): Date | null {
  const date = new Date(builtAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** 本地时区 YYYY-MM-DD HH:mm（无秒、无 T/Z、无毫秒） */
function formatLocalMinute(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** branch / commitShort / builtAt 三段按有值才拼，全缺失时返回 null（About 不渲染第二行） */
export function formatBuildInfoDisplay(buildInfo: BuildInfo, t: Translations): string | null {
  const parts: string[] = [];
  if (buildInfo.branch) parts.push(t.about.buildBranch.replace('{branch}', buildInfo.branch));
  if (buildInfo.commitShort) parts.push(t.about.buildCommit.replace('{commitShort}', buildInfo.commitShort));
  const builtAt = parseBuiltAt(buildInfo.builtAt);
  if (builtAt) parts.push(formatLocalMinute(builtAt));
  return parts.length > 0 ? parts.join(' · ') : null;
}
