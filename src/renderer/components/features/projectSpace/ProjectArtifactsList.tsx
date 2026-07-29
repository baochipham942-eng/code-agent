// ============================================================================
// ProjectArtifactsList —— 项目协作空间「资产」tab。
// projectClient.getProjectArtifacts(projectId) 列表：名称/kind/时间/来源会话跳转。
// 资料库无独立可复用列表组件（LibraryPanel 是单体），本列表按工单自建。
// ============================================================================

import React, { useEffect, useState } from 'react';
import { CornerUpRight, FileBox } from 'lucide-react';
import type { ProjectArtifact } from '@shared/contract/project';
import { getProjectArtifacts } from '../../../services/projectClient';
import { useI18n } from '../../../hooks/useI18n';
import { formatRelativeTime } from '../../../utils/i18nTime';
import { Badge } from '../../primitives/Badge';
import { EmptyState } from '../../primitives/EmptyState';
import { IconButton } from '../../primitives/IconButton';

export interface ProjectArtifactsListProps {
  projectId: string;
  /** 动态流跳入时要高亮的 artifact id（可选） */
  highlightId?: string | null;
  onOpenSession: (sessionId: string) => void;
}

function artifactDisplayName(artifact: ProjectArtifact): string {
  if (artifact.title?.trim()) return artifact.title.trim();
  if (artifact.path) {
    const segments = artifact.path.split(/[\\/]/).filter(Boolean);
    if (segments.length > 0) return segments[segments.length - 1];
  }
  return artifact.id;
}

export const ProjectArtifactsList: React.FC<ProjectArtifactsListProps> = ({
  projectId,
  highlightId = null,
  onOpenSession,
}) => {
  const { t } = useI18n();
  const ps = t.projectSpace;
  const [artifacts, setArtifacts] = useState<ProjectArtifact[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    getProjectArtifacts(projectId)
      .then((list) => {
        if (!cancelled) setArtifacts(list);
      })
      .catch(() => {
        if (!cancelled) setArtifacts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (artifacts === null) {
    return <div className="py-10 text-center text-sm text-zinc-600">{t.common.loading}</div>;
  }

  if (artifacts.length === 0) {
    return <EmptyState variant="panel" icon={FileBox} text={ps.assetsEmpty} />;
  }

  return (
    <div className="grid gap-1" data-testid="project-space-assets-list">
      {artifacts.map((artifact) => (
        <div
          key={artifact.id}
          data-testid={`project-space-asset-${artifact.id}`}
          className={`group flex min-w-0 items-center gap-3 rounded-lg px-3 py-2 hover:bg-zinc-800/60 ${
            highlightId === artifact.id ? 'bg-zinc-800/70 ring-1 ring-violet-500/40' : ''
          }`}
        >
          <FileBox className="h-4 w-4 flex-shrink-0 text-zinc-500" />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-zinc-300">{artifactDisplayName(artifact)}</span>
            {artifact.sessionTitle ? (
              <span className="mt-0.5 block truncate text-xs text-zinc-600">{artifact.sessionTitle}</span>
            ) : null}
          </span>
          <Badge className="flex-shrink-0 border-zinc-700 bg-zinc-800/60 text-[10px] text-zinc-400">{artifact.kind}</Badge>
          <span className="flex-shrink-0 text-[11px] text-zinc-600 tabular-nums">
            {formatRelativeTime(t, artifact.createdAt)}
          </span>
          {artifact.sessionId ? (
            <IconButton
              size="sm"
              variant="ghost"
              icon={<CornerUpRight className="h-3.5 w-3.5" />}
              aria-label={ps.assetFromSession}
              title={ps.assetFromSession}
              data-testid={`project-space-asset-jump-${artifact.id}`}
              onClick={() => onOpenSession(artifact.sessionId)}
            />
          ) : null}
        </div>
      ))}
    </div>
  );
};

