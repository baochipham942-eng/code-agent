// ============================================================================
// 反爬指纹检测 — 给 WebFetch 结果加 hint，提示模型换 Bash + 本地 CLI 路径
//
// 设计目的：
//   - 27-turn xiaohongshu session 失败模式：mimo 反复 WebFetch 同一 URL，
//     每次拿到反爬框架 HTML 后没意识到这是反爬，继续重试 12 次。
//   - 解决方案不是硬编码"小红书 → opencli"，而是当工具结果命中反爬指纹时，
//     在 result 末尾追加一段 hint，引导模型用 Bash 调本地 CLI（清单见
//     <env-capabilities>）。给原则不给映射。
//
// 检测维度（任一命中即触发）：
//   1. 已知反爬错误码：xiaohongshu 的 error_code=300031, 哔哩哔哩的某些 -403
//   2. HTTP 状态：403 Forbidden / 429 Too Many Requests（在 error string 里）
//   3. URL 重定向 marker：path 里含 /404/sec_w、/captcha、/login
//   4. Cloudflare/反爬模板字符串：Just a moment, Attention Required, captcha
//   5. 长度异常：成功响应但内容 < 200 chars 且 URL 是社交媒体域名
// ============================================================================

const ERROR_CODE_PATTERNS = [
  /error_code=300031/i,    // 小红书：拒绝访问
  /error_code=300017/i,    // 小红书：URL invalid（无 xsec_token 时的反爬重定向）
  /error_msg=url%20is%20invalid/i,  // 小红书 URL invalid 的另一种 marker
  /\bcode["']?\s*[:=]\s*["']?-?40[123]\b/,  // -401 / -403 / 401
  /\bstatus_code["']?\s*[:=]\s*["']?429\b/,
];

const HTTP_PATTERNS = [
  /HTTP 40[39]\b/i,
  /HTTP 429\b/i,
  /\b403\s+Forbidden\b/i,
  /\b429\s+Too Many Requests\b/i,
];

const URL_REDIRECT_MARKERS = [
  '/404?source=',
  '/sec_w',
  '/captcha',
  '/sec/captcha',
  '/login?',
  '/sign-in?',
  '/website-login/',  // 小红书登录墙重定向（含 captcha / error 子页）
  '/website-login/error',
  '/website-login/captcha',
];

const CHALLENGE_MARKERS = [
  'Just a moment',
  'Attention Required',
  'cf-chl',
  'captcha-bypass',
  '请完成安全验证',
  '人机验证',
  '验证码',
];

const SOCIAL_MEDIA_DOMAINS = [
  'xiaohongshu.com', 'douyin.com', 'weibo.com', 'bilibili.com',
  'zhihu.com', 'douban.com', 'mp.weixin.qq.com',
  'twitter.com', 'x.com', 'instagram.com', 'tiktok.com',
];

/** Hint 文本包含此 marker，下游（messageProcessor）扫描 result 时用于识别是否命中反爬 */
export const ANTI_SCRAPING_HINT_MARKER = '[SYSTEM HINT: this response looks like an anti-scraping wall';

// Hint 措辞演化历史：
// v1: 只说 "use opencli/jina via Bash" → 模型用了 `opencli web read URL` 但缺 `--url` 参数失败
// v2 (现在)：明确引导 `opencli list` 发现 adapter + `opencli <site> --help` 看子命令模式，
//   给一个具体例子（xiaohongshu note <id>）让模型理解 site-specific adapter 的存在
const ANTI_SCRAPING_HINT =
  ANTI_SCRAPING_HINT_MARKER +
  ' (HTTP 403/429, captcha challenge, redirect to /404, or empty page on a known site). ' +
  'WebFetch cannot bypass this — pick a different tool. ' +
  'If `opencli` is in <env-capabilities>, it likely has a site-specific adapter that handles login state. ' +
  'Discovery path via Bash: ' +
  '(1) `opencli list` lists ALL site adapters (xiaohongshu/zhihu/weibo/bilibili/etc — top-level `--help` does NOT show them). ' +
  '(2) `opencli <site> --help` shows site subcommands (e.g. `opencli xiaohongshu note <note-id>` extracts note content directly — much better than the generic `opencli web read --url ...`). ' +
  'Do NOT retry WebFetch with minor URL variations on the same site.]';

function isSocialMediaUrl(url: string | undefined): boolean {
  if (!url) return false;
  return SOCIAL_MEDIA_DOMAINS.some((d) => url.includes(d));
}

/**
 * 检测响应是否命中反爬指纹。命中返回 hint 字符串，否则返回 null。
 * 调用方把 hint 追加到 result.output / result.error 末尾，不改变 success 状态。
 */
export function detectAntiScrapingHint(
  url: string | undefined,
  success: boolean,
  output: unknown,
  error: unknown,
): string | null {
  const text = [
    typeof output === 'string' ? output : '',
    typeof error === 'string' ? error : '',
  ].join('\n');

  // 1. 错误码指纹
  if (ERROR_CODE_PATTERNS.some((re) => re.test(text))) {
    return ANTI_SCRAPING_HINT;
  }

  // 2. HTTP 403/429
  if (HTTP_PATTERNS.some((re) => re.test(text))) {
    return ANTI_SCRAPING_HINT;
  }

  // 3. URL 重定向 marker（出现在 fetched 内容的 final url 里）
  if (URL_REDIRECT_MARKERS.some((m) => text.includes(m))) {
    return ANTI_SCRAPING_HINT;
  }

  // 4. Cloudflare / 验证码模板
  if (CHALLENGE_MARKERS.some((m) => text.includes(m))) {
    return ANTI_SCRAPING_HINT;
  }

  // 5. 社交媒体域名 + 异常空响应（< 200 chars 通常是反爬框架的最小响应）
  if (success && isSocialMediaUrl(url) && typeof output === 'string' && output.trim().length < 200) {
    return ANTI_SCRAPING_HINT;
  }

  return null;
}
