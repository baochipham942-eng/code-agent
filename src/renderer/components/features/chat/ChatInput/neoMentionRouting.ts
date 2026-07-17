import type { MentionRoutingAgent } from './agentMentionRouting';
import { zh, type Translations } from '../../../../i18n/zh';

export interface ParsedNeoTagInvocation {
  userText: string;
  originalContent: string;
}

/**
 * @neo 是保留 mention，路由到 Neo 工作卡而非 swarm agent。
 * 作为合成候选注入 @ mention 下拉，让用户可见、可点选（发现性），
 * 选中后插入 `@neo `（token = 归一化 name = 'neo'），触发工作卡链路。
 */
export const NEO_TAG_MENTION_AGENT: MentionRoutingAgent & { role: string } = {
  id: '__neo_tag__',
  name: 'Neo',
  role: zh.neoMentionRouting.workCardRole,
};

/** 按当前语言重写 NEO_TAG_MENTION_AGENT 的展示态 role（id/name 保持稳定）。 */
export function localizeNeoTagMentionAgent(t: Translations): MentionRoutingAgent & { role: string } {
  return { ...NEO_TAG_MENTION_AGENT, role: t.neoMentionRouting.workCardRole };
}

/**
 * 建议展示 Neo 候选的时机：
 * - 裸 @（空 query）：像 @teammate 一样置顶召唤 Neo,并借此压掉文件 popup 噪音（产品负责人 2026-07-02）。
 * - @ 后接 'neo' 的前缀（n / ne / neo）：继续置顶 Neo。
 * - @ 后接其它前缀（如文件名 src/...）：不召唤 Neo,文件 mention 照常。
 */
export function shouldSuggestNeoMention(query: string): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return 'neo'.startsWith(normalized);
}

export const NEO_TOPIC_MENTION_PREFIX = '__neo_topic__:';

const CLOSED_TOPIC_STATUSES = new Set(['cancelled', 'archived']);
const MAX_TOPIC_CANDIDATES = 5;

export interface NeoTopicMentionSource {
  workCardId: string;
  title: string;
  status: string;
  updatedAt: number;
}

/** @neo 下拉的「续接既有 topic」候选：最近活跃前 5，已结束的不进（ADR-035 D1）。 */
export function buildNeoTopicMentionCandidates(
  topics: NeoTopicMentionSource[],
  t: Translations = zh,
): Array<MentionRoutingAgent & { role: string }> {
  return topics
    .filter((topic) => !CLOSED_TOPIC_STATUSES.has(topic.status))
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_TOPIC_CANDIDATES)
    .map((topic) => ({
      id: `${NEO_TOPIC_MENTION_PREFIX}${topic.workCardId}`,
      name: 'Neo',
      role: `${t.neoMentionRouting.continuationRolePrefix}${topic.title.length > 24 ? `${topic.title.slice(0, 23)}…` : topic.title}`,
    }));
}

export function isLeadingNeoTagInput(value: string): boolean {
  const trimmedStart = value.replace(/^\s+/, '');
  return /^@neo(?:\s|$)/i.test(trimmedStart);
}

export function parseLeadingNeoTagInvocation(content: string): ParsedNeoTagInvocation | null {
  const trimmedStart = content.replace(/^\s+/, '');
  const match = trimmedStart.match(/^@neo(?:\s+|$)/i);
  if (!match) return null;

  return {
    userText: trimmedStart.slice(match[0].length).trim(),
    originalContent: trimmedStart,
  };
}
