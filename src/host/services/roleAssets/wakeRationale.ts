// ============================================================================
// Wake rationale / topic-preference helpers (N-WAKE-RATIONALE)
// ============================================================================
// Pure parse + constraint helpers used by the wake loop. Kept out of
// roleProactivity.ts so that file stays under the max-lines ratchet.

import { ROLE_PROACTIVITY } from '../../../shared/constants';
import type { RoleProactivityConfig } from '../../../shared/contract/roleAssets';
import { sanitizeTopicList } from '../../../shared/roleTopicList';

export { sanitizeTopicList };

export interface ParsedWakeRationale {
  /** Why this is worth interrupting the user; absent when the tag is missing/empty. */
  rationale?: string;
  /** Citations (session / file / memory). Empty tag is allowed and omitted. */
  evidence?: string;
  /** True when <rationale> is missing, empty, or unclosed. Never invents a reason. */
  missing: boolean;
}

export function parseWakeRationale(finalOutput: string): ParsedWakeRationale {
  const rationaleMatch = finalOutput.match(ROLE_PROACTIVITY.RATIONALE_TAG_PATTERN);
  const evidenceMatch = finalOutput.match(ROLE_PROACTIVITY.EVIDENCE_TAG_PATTERN);
  const rationaleRaw = rationaleMatch?.[1]?.trim() ?? '';
  const evidenceRaw = evidenceMatch?.[1]?.trim() ?? '';
  const rationale = rationaleRaw
    ? rationaleRaw.slice(0, ROLE_PROACTIVITY.RATIONALE_MAX_CHARS)
    : undefined;
  const evidence = evidenceRaw || undefined;
  return {
    ...(rationale ? { rationale } : {}),
    ...(evidence ? { evidence } : {}),
    missing: !rationale,
  };
}

export function stripWakeMarkup(text: string): string {
  return text
    .replace(ROLE_PROACTIVITY.DECISION_TAG_PATTERN, '')
    .replace(ROLE_PROACTIVITY.RATIONALE_TAG_PATTERN, '')
    .replace(ROLE_PROACTIVITY.EVIDENCE_TAG_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Hard exclude against the wake output (body + parsed rationale).
 * ASCII 短词（≤2）走整词 / 词边界，避免 AI 误伤 DETAILS；其余仍为大小写不敏感子串。
 * Empty topics never hit.
 */
export function topicExcludeHits(text: string, topicsExclude: unknown): boolean {
  const topics = sanitizeTopicList(topicsExclude);
  if (topics.length === 0) return false;
  const haystack = text.toLowerCase();
  return topics.some((topic) => {
    const needle = topic.toLowerCase();
    if (needle.length <= 2 && /^[a-z0-9]+$/.test(needle)) {
      return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(needle)}(?:[^a-z0-9]|$)`).test(haystack);
    }
    return haystack.includes(needle);
  });
}

export function formatTopicPreferencePrompt(
  config: Pick<RoleProactivityConfig, 'topicsInclude' | 'topicsExclude'>,
): string {
  const include = sanitizeTopicList(config.topicsInclude);
  const exclude = sanitizeTopicList(config.topicsExclude);
  if (include.length === 0 && exclude.length === 0) return '';
  const lines = ['话题偏好：'];
  if (include.length > 0) {
    lines.push(`- 用户想听：${include.join('、')}`);
  }
  if (exclude.length > 0) {
    lines.push(`- 永远别提（硬约束：命中则必须 <decision>silence</decision>，不要输出建议）：${exclude.join('、')}`);
  }
  return lines.join('\n');
}


