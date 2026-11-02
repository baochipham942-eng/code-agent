// 人机验证 / 风控页判定：只看挑战信号（标题、标题行、挑战 iframe、短页面），不对整页正文做关键词匹配。
// 依据：FlareSolverr 按页面标题 + DOM 选择器判挑战，Cloudflare 文档按结构标记（cf-mitigated）判挑战。

/** 正文短于该长度才允许用裸词（captcha / 风控 / 验证码）判挑战；真实挑战页几乎没有别的内容。 */
const CHALLENGE_SHORT_BODY_MAX_CHARS = 800;
const CHALLENGE_HEADING_MAX_CHARS = 80;

const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|verify you are human|verifying you are human|unusual traffic|安全验证|人机验证|请稍候/i;
const STRONG_PHRASE = /verify you are human|verifying you are human|complete the captcha|checking your browser|unusual traffic|are you a robot|安全验证|人机验证|请完成验证|请完成安全验证/i;
const BARE_WORD = /captcha|risk[ -]control|风控|验证码/i;

export interface BrowserChallengeSignals {
  title?: string | null;
  headings?: ReadonlyArray<string> | null;
  bodyText?: string | null;
  frameUrls?: ReadonlyArray<string> | null;
}

function isChallengeFrameUrl(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('/recaptcha/api2/anchor') || lower.includes('/recaptcha/enterprise/anchor') || lower.includes('/bframe')) {
    return !/[?&]size=invisible\b/.test(lower);
  }
  return lower.includes('hcaptcha.com') || lower.includes('challenges.cloudflare.com');
}

export function detectBrowserChallenge(signals: BrowserChallengeSignals): boolean {
  if (CHALLENGE_TITLE.test(signals.title || '')) return true;
  for (const heading of signals.headings || []) {
    const text = (heading || '').trim();
    if (text.length > 0 && text.length <= CHALLENGE_HEADING_MAX_CHARS && STRONG_PHRASE.test(text)) return true;
  }
  if ((signals.frameUrls || []).some(isChallengeFrameUrl)) return true;
  const body = (signals.bodyText || '').trim();
  if (body.length > 0 && body.length < CHALLENGE_SHORT_BODY_MAX_CHARS) {
    return STRONG_PHRASE.test(body) || BARE_WORD.test(body);
  }
  return false;
}
