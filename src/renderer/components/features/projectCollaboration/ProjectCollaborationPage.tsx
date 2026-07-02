import React from 'react';
import { UsersRound } from 'lucide-react';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { ProjectCollaborationPanel } from './ProjectCollaborationPanel';

export interface ProjectCollaborationPageProps {
  projectId?: string | null;
  onClose: () => void;
}

export const ProjectCollaborationPage: React.FC<ProjectCollaborationPageProps> = ({
  projectId = null,
  onClose,
}) => (
  <FullScreenPage testId="project-collaboration-page">
    <FullScreenPageHeader
      icon={<UsersRound className="h-4 w-4 text-violet-300" />}
      title="Neo 协同"
      description={projectId ? `Project work cards · ${projectId}` : '所有 @neo topic'}
      onClose={onClose}
      closeLabel="关闭 Neo 协同"
    />
    <div className="min-h-0 flex-1">
      <ProjectCollaborationPanel projectId={projectId} />
    </div>
  </FullScreenPage>
);

export default ProjectCollaborationPage;
