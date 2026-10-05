// IACT `!run?cmd=<percent-encoded>` 载荷。
// 不用 URLSearchParams：它会把 `+` 变成空格，命令必须按百分号原样解码，且不 trim。

/** 裸 `!run`、缺/空 `cmd`、或百分号解码失败时返回 null。成功时返回解码后的命令原文。 */
export function parseRunHref(href: string): string | null {
  if (!href.startsWith('!run?')) return null;
  const raw = firstQueryValue(href.slice('!run?'.length), 'cmd');
  if (raw === null || raw.length === 0) return null;
  try {
    const command = decodeURIComponent(raw);
    return command.length === 0 ? null : command;
  } catch {
    return null;
  }
}

function firstQueryValue(query: string, key: string): string | null {
  for (const part of query.split('&')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq) === key) return part.slice(eq + 1);
  }
  return null;
}
