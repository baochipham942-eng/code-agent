// 浏览器 tab 地址栏输入归一化（2026-08-04 地址栏工单）：
// - 无协议前缀一律补 https://；
// - 明显是搜索词（含空白 / 无点单词）判无效——地址栏不做搜索，由调用方提示无效地址；
// - 只放行 http(s)，其他协议（file:、ftp: 等）一律拒绝。

export type BrowserAddressNormalization =
  | { ok: true; url: string }
  | { ok: false };

const IPV4_HOST_PATTERN = /^(\d{1,3}\.){3}\d{1,3}$/;

function parseHttpUrl(candidate: string): URL | null {
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname) return null;
  return parsed;
}

/** 无协议输入的主机启发式：带点域名 / localhost / IPv4 才算网址，其余按搜索词处理。 */
function looksLikeHost(hostname: string): boolean {
  if (hostname === 'localhost') return true;
  if (IPV4_HOST_PATTERN.test(hostname)) return true;
  return hostname.includes('.');
}

export function normalizeBrowserAddressInput(raw: string): BrowserAddressNormalization {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false };

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    const parsed = parseHttpUrl(trimmed);
    return parsed ? { ok: true, url: parsed.href } : { ok: false };
  }

  // 含空白 → 搜索词；无协议直接拼 https:// 再验主机形态。
  if (/\s/.test(trimmed)) return { ok: false };
  const parsed = parseHttpUrl(`https://${trimmed}`);
  if (!parsed || !looksLikeHost(parsed.hostname)) return { ok: false };
  return { ok: true, url: parsed.href };
}
