// ============================================================================
// Ground-Truth Gate — 反幻觉伪造的最后一道防线
//
// 失败模式（27-turn xiaohongshu session）：
//   - 用户给 URL 让"提炼笔记"
//   - WebFetch 12 次反爬全失败
//   - 模型最终把 WebSearch summary 拼成"GPT-5.5 发布"的内容当成"成功获取笔记"上交
//   - 内容完全是幻觉，但格式专业、有 emoji、看起来 confident
//
// 设计：不替换内容（避免破坏可读性），在 assistant_response 前面加 disclaimer，
// 让用户看到"反爬限制下未能直接读取，以下内容可能不准确"——是诚实标注，不是删除。
//
// 触发条件（全部满足才加 disclaimer）：
//   1. 用户首条消息里含 URL
//   2. 本 run 中 anti-scraping hint 命中次数 >= 阈值
//   3. 当前 assistant_response 看起来像"成功输出"（>200 chars 且无显式失败措辞）
//
// 不在以下场景触发：
//   - 用户本来就说"不确定行不行试试"——但简单实现暂时不区分；让 disclaimer 误伤
//     比让幻觉过去好（false positive 用户能轻易忽略，false negative 是信任灾难）
// ============================================================================

const URL_PATTERN = /https?:\/\/\S+/i;

/** 命中反爬几次以上视为"基础事实缺失" */
export const GROUND_TRUTH_HIT_THRESHOLD = 3;

/** disclaimer 文本，prefix 到 assistant message content 前 */
export const GROUND_TRUTH_DISCLAIMER =
  '> ⚠️ **抓取受限提示**：本次请求中目标 URL 的内容多次遭遇反爬/访问失败。以下内容**部分基于搜索摘要或推断**，可能与原文不一致。建议人工核对原文，或换用本机的 `opencli` / `jina` 等具备 session 能力的工具重试。\n\n';

/**
 * 用户消息含 URL → 这是"读取/提炼"类任务，本来期待 ground truth
 */
export function userMessageMentionsUrl(userMessage: string | undefined): boolean {
  if (!userMessage) return false;
  return URL_PATTERN.test(userMessage);
}

/**
 * 输出看起来像"成功"格式（避免给已经诚实说"抓不到"的回复也加 disclaimer）
 */
function looksLikeSuccessfulOutput(content: string): boolean {
  if (!content || content.length < 200) return false;
  const failureMarkers = [
    '抓取失败', '无法获取', '访问失败', '反爬', '受限',
    'failed to fetch', 'unable to access', 'could not retrieve',
    '抱歉', 'sorry, I',
  ];
  const lc = content.toLowerCase();
  // 含失败措辞 → 模型已经诚实告知，不需要再加 disclaimer
  return !failureMarkers.some((m) => lc.includes(m.toLowerCase()));
}

/**
 * 决定是否给 assistant message 加 disclaimer。
 *
 * @param userFirstMessage 用户首条消息（用于检查是否含 URL）
 * @param antiScrapingHits 本 run anti-scraping marker 命中次数
 * @param assistantContent 即将落地的 assistant message content
 * @returns 加好 disclaimer 的 content；不需要加时返回原 content
 */
export function applyGroundTruthGate(
  userFirstMessage: string | undefined,
  antiScrapingHits: number,
  assistantContent: string,
): { content: string; applied: boolean } {
  if (!userMessageMentionsUrl(userFirstMessage)) {
    return { content: assistantContent, applied: false };
  }
  if (antiScrapingHits < GROUND_TRUTH_HIT_THRESHOLD) {
    return { content: assistantContent, applied: false };
  }
  if (!looksLikeSuccessfulOutput(assistantContent)) {
    return { content: assistantContent, applied: false };
  }

  return {
    content: GROUND_TRUTH_DISCLAIMER + assistantContent,
    applied: true,
  };
}
