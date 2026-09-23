// ============================================================================
// Partial-search-results reporting (shared by Grep / Glob tools)
//
// N-SEARCH-PARTIAL-RESULTS：搜索工具遇到「部分路径不可读、但可读路径已有结果」时，
// 必须把不完整标记如实送到模型可见的 output/meta，而不是丢弃结果或静默截断。
// 模型用这两个工具做存在性判断（「X 在仓库里存在吗」），被吞掉的不可读目录
// 会变成自信的错误答案 —— 「没搜到 ≠ 不存在」。
// ============================================================================

/** 列出的不可读路径上限，超出部分折叠为 "+N more" 尾行 */
const MAX_PARTIAL_PATH_LINES = 20;

/**
 * 把 rg / grep（BSD、GNU、ugrep 变体）的 stderr 解析成 "path: reason" 展示条目：
 * - rg:    `rg: /path: Permission denied (os error 13)`
 * - grep:  `grep: /path: Permission denied`
 * - ugrep: `ugrep: warning: cannot open directory /path: Permission denied`
 * 识别不了的行原样保留 —— 多报一条比漏报强。
 */
export function parseSearchErrorStderr(stderr: string): string[] {
  const entries: string[] = [];
  for (const raw of stderr.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let rest = line.replace(/^[A-Za-z0-9_-]+:\s+/, '');
    rest = rest.replace(/^warning:\s+/i, '');
    rest = rest.replace(/^cannot open (?:directory|file)\s+/i, '');
    if (rest) entries.push(rest);
  }
  return entries;
}

/**
 * 追加到工具输出末尾的 `[partial]` 块。无可报内容时返回空串（99% 无错路径零噪音）。
 */
function buildPartialBlock(unreadablePaths: string[]): string {
  if (unreadablePaths.length === 0) return '';
  const shown = unreadablePaths.slice(0, MAX_PARTIAL_PATH_LINES);
  const more = unreadablePaths.length - shown.length;
  const lines = [
    `[partial] ${unreadablePaths.length} path${unreadablePaths.length === 1 ? '' : 's'} could not be searched:`,
    ...shown.map((entry) => `  ${entry}`),
  ];
  if (more > 0) lines.push(`  ... and ${more} more`);
  return lines.join('\n');
}

/** applyPartialToOutput 返回的、展开进 result meta 的部分结果字段 */
export interface PartialSearchMeta {
  partial?: true;
  unreadablePaths?: string[];
}

/**
 * 把 `[partial]` 块接到最终输出文本末尾，并给出要展开进 meta 的字段。
 * 无不可读路径时原样返回（输出与旧版逐字节一致）。
 */
export function applyPartialToOutput(
  output: string,
  unreadablePaths: string[],
): { output: string; partialMeta: PartialSearchMeta } {
  const block = buildPartialBlock(unreadablePaths);
  if (!block) return { output, partialMeta: {} };
  return {
    output: `${output}\n\n${block}`,
    partialMeta: { partial: true, unreadablePaths },
  };
}
