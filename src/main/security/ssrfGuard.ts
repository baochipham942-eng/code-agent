// ============================================================================
// SSRF 守卫 —— 统一判定「fetch 目标地址是否安全公网」，挡私网/环回/链路本地/元数据。
//
// 自定义生图模型端点借鉴项①：用户自填 OpenAI 兼容 base URL，主进程会向它发请求，
// 必须挡掉指向内网/云元数据（169.254.169.254）的地址，杜绝把 app 当 SSRF 跳板。
// 同时收口已有裸下载入口 downloadFile（任意 URL fetch，艾克斯审计修订 2）。
//
// 注意：守卫基于 hostname 字面量判断，不解析 DNS——可挡 IP 直连与 localhost，
// 但 DNS rebinding（域名解析到私网）超出本期范围。逻辑与 imageGenerationService
// 的 isSafeImageUrl 同源（host 判定下沉到这里，避免两份私网规则漂移）。
// ============================================================================

/**
 * hostname 是否私网/环回/链路本地/元数据地址（不解析 DNS）。
 * 入参可为裸 hostname（'127.0.0.1'/'localhost'）或 WHATWG URL 的 IPv6 字面量（'[::1]'）。
 */
export function isPrivateOrLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (h === 'localhost') return true;

  // 私网/环回/链路本地/未指定 IPv4
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a === 127 || a === 10 || a === 0) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }

  // IPv6 字面量——WHATWG URL 的 hostname 保留方括号（如 '[::1]'）。去括号再判，
  // 且这些前缀检查只能在 IPv6 字面量上跑，否则会误杀以 fc/fd/fe80 开头的公网域名。
  const h6 = h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : (h.includes(':') ? h : null);
  if (h6 !== null) {
    if (h6 === '::1' || h6 === '::') return true; // 环回/未指定
    if (h6.startsWith('fc') || h6.startsWith('fd')) return true; // ULA fc00::/7
    if (h6.startsWith('fe80')) return true; // 链路本地
    if (h6.startsWith('::ffff:')) return true; // IPv4-mapped——保守整段拒绝，挡映射私网绕过
    return false;
  }

  return false;
}

/**
 * 校验自定义端点 base URL：必须 https 公网，返回去尾斜杠的规范化 URL，否则抛错。
 * 出图请求会拼到这个 base 后面发起，故守卫从严（只放行 https）。
 */
export function assertSafeCustomBaseUrl(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('自定义端点 base URL 不能为空');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`自定义端点 base URL 非法：${trimmed}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error('自定义端点 base URL 必须是 https');
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error(`拒绝指向私网/环回/元数据地址的 base URL：${url.hostname}`);
  }
  return trimmed.replace(/\/+$/, '');
}

/**
 * 校验裸下载 URL：放行 http/https 公网（下载比出图宽松，允许 http），拒私网/非 http(s)。
 * 用于收口 downloadFile 这个 IPC 暴露的任意 URL fetch 入口。
 */
export function assertSafeDownloadUrl(raw: string): void {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) throw new Error('下载 URL 不能为空');
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`下载 URL 非法：${trimmed}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error(`拒绝非 http(s) 协议的下载 URL：${url.protocol}`);
  }
  if (isPrivateOrLocalHost(url.hostname)) {
    throw new Error(`拒绝指向私网/环回/元数据地址的下载 URL：${url.hostname}`);
  }
}
