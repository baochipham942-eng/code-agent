// ============================================================================
// displayPath — 用户可见路径展示（中段省略 + 保留文件名）
// 禁止尾部截断成 `…/artifacts/overview-batch2-note.m…` 这种双省略形态。
// ============================================================================

/**
 * 把路径压成用户可读的短展示串。
 * 规则：
 * - 段数 ≤2：原样返回（相对短路径）
 * - 段数 >2：优先 `…/parent/file`（始终压掉前缀，不靠 CSS 尾截）
 * - 末两段仍超 maxLen：保留完整文件名，压缩目录；文件名本身超长再中段省略
 */
export function formatDisplayPath(path: string, maxLen = 48): string {
  if (!path) return '';
  const normalized = path.trim();
  if (!normalized) return '';

  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0) return normalized;

  const fileName = segments[segments.length - 1] || normalized;

  // 浅路径（相对 1–2 段）直接返回；绝对根路径只有一段也直接返回
  if (segments.length <= 2 && normalized.length <= maxLen) {
    return normalized;
  }

  // 文件名本身就超长：中段省略，尽量保住扩展名
  if (fileName.length >= maxLen - 1) {
    return middleEllipsis(fileName, maxLen);
  }

  // 默认：末两段 + 前缀省略
  if (segments.length >= 2) {
    const tail2 = `${segments[segments.length - 2]}/${fileName}`;
    const candidate = `…/${tail2}`;
    if (candidate.length <= maxLen) return candidate;
    // 末两段超预算：只保文件名
    if (`…/${fileName}`.length <= maxLen) return `…/${fileName}`;
  }

  if (fileName.length + 2 <= maxLen) {
    return `…/${fileName}`;
  }

  return middleEllipsis(fileName, maxLen);
}

/** 真中段省略：首尾各留一半，中间一个 `…` */
export function middleEllipsis(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  if (maxLen <= 1) return '…';
  const budget = maxLen - 1;
  const head = Math.ceil(budget / 2);
  const tail = Math.floor(budget / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - tail)}`;
}
