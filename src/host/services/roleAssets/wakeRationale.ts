// ============================================================================
// Wake rationale / topic-preference helpers (N-WAKE-RATIONALE)
// ============================================================================
// Pure parse + constraint helpers used by the wake loop. Kept out of
// roleProactivity.ts so that file stays under the max-lines ratchet.

import { ROLE_PROACTIVITY } from '../../../shared/constants';
import type { RoleProactivityConfig } from '../../../shared/contract/roleAssets';

export interface ParsedWakeRationale {
  /** Why this is worth interrupting the user; absent when the tag is missing/empty. */
  rationale?: string;
  /** Citations (session / file / memory). Empty tag is allowed and omitted. */
  evidence?: string;
  /** True when <rationale> is missing, empty, or unclosed. Never invents a reason. */
  missing: boolean;
}

const TOPIC_MAX_ITEMS = 20;
const TOPIC_MAX_CHARS = 40;

export function sanitizeTopicList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const clipped = trimmed.slice(0, TOPIC_MAX_CHARS);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= TOPIC_MAX_ITEMS) break;
  }
  return out;
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

/**
 * Hard exclude: case-insensitive substring match against the wake output
 * (body + parsed rationale). Empty topics never hit.
 */
export function topicExcludeHits(text: string, topicsExclude: unknown): boolean {
  const topics = sanitizeTopicList(topicsExclude);
  if (topics.length === 0) return false;
  const haystack = text.toLowerCase();
  return topics.some((topic) => haystack.includes(topic.toLowerCase()));
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

export function formatHistoryWhySuffix(parsed: ParsedWakeRationale): string {
  if (parsed.missing) return ' | why: (missing)';
  const parts = [` | why: ${parsed.rationale}`];
  if (parsed.evidence) parts.push(` | evidence: ${parsed.evidence}`);
  return parts.join('');
}
