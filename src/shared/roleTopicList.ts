import { ROLE_PROACTIVITY } from './constants';

/** 话题偏好去空白、截断、去重。host 写入与设置页输入共用。 */
export function sanitizeTopicList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim().replace(/\s+/g, ' ');
    if (!trimmed) continue;
    const clipped = trimmed.slice(0, ROLE_PROACTIVITY.TOPIC_MAX_CHARS);
    const key = clipped.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(clipped);
    if (out.length >= ROLE_PROACTIVITY.TOPIC_MAX_ITEMS) break;
  }
  return out;
}
