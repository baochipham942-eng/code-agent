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
  name: zh.neoMentionRouting.workCardName,
  role: zh.neoMentionRouting.workCardRole,
};

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
    .map((topic) => {
      const truncatedTitle = topic.title.length > 24 ? `${topic.title.slice(0, 23)}…` : topic.title;
      return {
        id: `${NEO_TOPIC_MENTION_PREFIX}${topic.workCardId}`,
        name: `${t.neoMentionRouting.continuationNamePrefix}${truncatedTitle}`,
        role: t.neoMentionRouting.continuationRole,
      };
    });
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
