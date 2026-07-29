import type { NeoWorkCard } from '@shared/contract/tag';
import type { ProjectArtifact } from '@shared/contract/project';

// ============================================================================
// 项目协作空间（批P）：动态流三源合并（会话进展 / @neo topic 变更 / 产物生成）。
// 纯函数——数据由页面各自 IPC 取好后喂进来，方便单测与空态降级。
// ============================================================================

type ProjectActivityKind = 'session' | 'topic' | 'artifact';

export interface ProjectActivityEntry {
  kind: ProjectActivityKind;
  /** 源对象 id：sessionId / workCardId / artifactId */
  id: string;
  title: string;
  at: number;
  /** topic 条目带状态（渲染相位 chip）；其余为空 */
  topicStatus?: NeoWorkCard['status'];
  /** 跳源会话（artifact 来源会话；topic 为主入口会话，由调用方按 topicPrimaryConversationId 传入） */
  sessionId?: string;
}

export const PROJECT_ACTIVITY_FEED_LIMIT = 50;

export interface BuildProjectActivityFeedInput {
  sessions: Array<{ id: string; title?: string | null; updatedAt: number }>;
  cards: Array<Pick<NeoWorkCard, 'id' | 'title' | 'status' | 'updatedAt' | 'sourceConversationId'>>;
  artifacts: Array<Pick<ProjectArtifact, 'id' | 'title' | 'sessionId' | 'createdAt'>>;
  limit?: number;
}

/** 三源按时间倒序合并；无效时间戳（<=0）条目丢弃，标题缺失给兜底文案。 */
export function buildProjectActivityFeed(input: BuildProjectActivityFeedInput): ProjectActivityEntry[] {
  const limit = input.limit ?? PROJECT_ACTIVITY_FEED_LIMIT;
  const entries: ProjectActivityEntry[] = [];
  for (const session of input.sessions) {
    if (!(session.updatedAt > 0)) continue;
    entries.push({
      kind: 'session',
      id: session.id,
      title: session.title?.trim() || '未命名会话',
      at: session.updatedAt,
      sessionId: session.id,
    });
  }
  for (const card of input.cards) {
    if (!(card.updatedAt > 0)) continue;
    entries.push({
      kind: 'topic',
      id: card.id,
      title: card.title,
      at: card.updatedAt,
      topicStatus: card.status,
      sessionId: card.sourceConversationId,
    });
  }
  for (const artifact of input.artifacts) {
    if (!(artifact.createdAt > 0)) continue;
    entries.push({
      kind: 'artifact',
      id: artifact.id,
      title: artifact.title?.trim() || '未命名产物',
      at: artifact.createdAt,
      sessionId: artifact.sessionId,
    });
  }
  return entries.sort((a, b) => b.at - a.at).slice(0, limit);
}
