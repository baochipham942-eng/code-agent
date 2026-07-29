// ============================================================================
// ProjectActivityFeed —— 项目协作空间「动态」tab。
// 三源取数（会话 / @neo topic / 产物）→ buildProjectActivityFeed 纯函数合并倒序，一次 50 条。
// 跳源：session → switchSession；topic → 切任务 tab；artifact → 切资产 tab（由父级回调落地）。
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import { FileBox, ListChecks, MessageSquare, CornerUpRight } from 'lucide-react';
import type { NeoWorkCard } from '@shared/contract/tag';
import type { ProjectArtifact } from '@shared/contract/project';
import { useSessionStore } from '../../../stores/sessionStore';
import { useI18n } from '../../../hooks/useI18n';
import { tagClient } from '../../../services/tagClient';
import { getProjectArtifacts } from '../../../services/projectClient';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { Badge } from '../../primitives/Badge';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';
import { buildProjectActivityFeed, type ProjectActivityEntry } from './projectSpaceData';

export interface ProjectActivityFeedProps {
  projectId: string;
  onOpenSession: (sessionId: string) => void;
  onOpenTopic: (cardId: string) => void;
  onOpenArtifact: (artifactId: string) => void;
}

type FeedCard = Pick<NeoWorkCard, 'id' | 'title' | 'status' | 'updatedAt' | 'sourceConversationId'>;

export const ProjectActivityFeed: React.FC<ProjectActivityFeedProps> = ({
  projectId,
  onOpenSession,
  onOpenTopic,
  onOpenArtifact,
}) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const sessions = useSessionStore((state) => state.sessions);
  const [cards, setCards] = useState<FeedCard[]>([]);
  const [artifacts, setArtifacts] = useState<Array<Pick<ProjectArtifact, 'id' | 'title' | 'sessionId' | 'createdAt'>>>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoaded(false);
    void Promise.all([
      tagClient.listByProject({ projectId }).catch(() => []),
      getProjectArtifacts(projectId).catch(() => []),
    ]).then(([cardDetails, artifactList]) => {
      if (cancelled) return;
      setCards(cardDetails.map((detail) => detail.workCard));
      setArtifacts(artifactList);
      setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const entries = useMemo(() => {
    const projectSessions = sessions
      .filter((session) => session.projectId === projectId)
      .map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt }));
    return buildProjectActivityFeed({ sessions: projectSessions, cards, artifacts });
  }, [sessions, cards, artifacts, projectId]);

  if (loaded && entries.length === 0) {
    return <EmptyState variant="panel" icon={ListChecks} text={ps.activityEmpty} />;
  }

  const kindLabel = (entry: ProjectActivityEntry) => (
    entry.kind === 'session' ? ps.activitySession : entry.kind === 'topic' ? ps.activityTopic : ps.activityArtifact
  );
  const kindIcon = (entry: ProjectActivityEntry) => (
    entry.kind === 'session'
      ? <MessageSquare className="h-4 w-4 text-zinc-500" />
      : entry.kind === 'topic'
        ? <ListChecks className="h-4 w-4 text-zinc-500" />
        : <FileBox className="h-4 w-4 text-zinc-500" />
  );
  const handleJump = (entry: ProjectActivityEntry) => {
    if (entry.kind === 'session') {
      onOpenSession(entry.sessionId ?? entry.id);
    } else if (entry.kind === 'topic') {
      onOpenTopic(entry.id);
    } else {
      onOpenArtifact(entry.id);
    }
  };

  return (
    <div className="grid gap-1" data-testid="project-space-activity-feed">
      {entries.map((entry) => (
        <div
          key={`${entry.kind}:${entry.id}`}
          data-testid={`project-space-activity-${entry.kind}-${entry.id}`}
          className="group flex items-center gap-3 rounded-lg px-3 py-2 hover:bg-zinc-800/60"
        >
          <span className="flex-shrink-0">{kindIcon(entry)}</span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-2">
              <span className="flex-shrink-0 text-xs text-zinc-500">{kindLabel(entry)}</span>
              {entry.topicStatus ? (
                <Badge className="border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">{entry.topicStatus}</Badge>
              ) : null}
            </span>
            <span className="mt-0.5 block truncate text-sm text-zinc-300">{entry.title}</span>
          </span>
          <span className="flex-shrink-0 text-[11px] text-zinc-600 tabular-nums">
            {formatRelativeTime(t, entry.at)}
          </span>
          <IconButton
            size="sm"
            variant="ghost"
            icon={<CornerUpRight className="h-3.5 w-3.5" />}
            aria-label={ps.openSource}
            data-testid={`project-space-activity-jump-${entry.kind}-${entry.id}`}
            onClick={() => handleJump(entry)}
          />
        </div>
      ))}
    </div>
  );
};

