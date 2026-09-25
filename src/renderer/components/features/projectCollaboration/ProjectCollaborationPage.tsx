import React, { useCallback, useEffect, useState } from 'react';
import { UsersRound } from 'lucide-react';
import { getProjectDetail } from '../../../services/projectClient';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { useSessionStore } from '../../../stores/sessionStore';
import { ProjectCollaborationPanel } from './ProjectCollaborationPanel';

export interface ProjectCollaborationPageProps {
  projectId?: string | null;
  onClose: () => void;
}

export const ProjectCollaborationPage: React.FC<ProjectCollaborationPageProps> = ({
  projectId = null,
  onClose,
}) => {
  const [projectWorkspacePath, setProjectWorkspacePath] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setProjectWorkspacePath(null);
    if (!projectId) return () => { cancelled = true; };
    getProjectDetail(projectId)
      .then((detail) => {
        if (!cancelled) setProjectWorkspacePath(detail.project.workspacePath ?? null);
      })
      .catch(() => {
        if (!cancelled) setProjectWorkspacePath(null);
      });
    return () => { cancelled = true; };
  }, [projectId]);

  // 详情里点「打开会话」：切到源会话并关掉全屏目录，直接回到对话现场
  const handleOpenConversation = useCallback((sessionId: string) => {
    void useSessionStore.getState().switchSession(sessionId);
    onClose();
  }, [onClose]);

  return (
    <FullScreenPage testId="project-collaboration-page" variant="inline">
      <FullScreenPageHeader
        icon={<UsersRound className="h-4 w-4 text-badge-accent" />}
        title="Neo 协同"
        description={projectId ? `所有 @neo topic · ${projectId}` : '所有 @neo topic'}
        onClose={onClose}
      />
      <div className="min-h-0 flex-1">
        <ProjectCollaborationPanel
          projectId={projectId}
          projectWorkspacePath={projectWorkspacePath}
          onOpenConversation={handleOpenConversation}
        />
      </div>
    </FullScreenPage>
  );
};

export default ProjectCollaborationPage;
