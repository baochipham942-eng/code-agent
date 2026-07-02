import React, { useCallback } from 'react';
import { UsersRound } from 'lucide-react';
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
  // 详情里点「打开会话」：切到源会话并关掉全屏目录，直接回到对话现场
  const handleOpenConversation = useCallback((sessionId: string) => {
    void useSessionStore.getState().switchSession(sessionId);
    onClose();
  }, [onClose]);

  return (
    <FullScreenPage testId="project-collaboration-page">
      <FullScreenPageHeader
        icon={<UsersRound className="h-4 w-4 text-violet-300" />}
        title="Neo 协同"
        description={projectId ? `Project work cards · ${projectId}` : '所有 @neo topic'}
        onClose={onClose}
        closeLabel="关闭 Neo 协同"
      />
      <div className="min-h-0 flex-1">
        <ProjectCollaborationPanel projectId={projectId} onOpenConversation={handleOpenConversation} />
      </div>
    </FullScreenPage>
  );
};

export default ProjectCollaborationPage;
