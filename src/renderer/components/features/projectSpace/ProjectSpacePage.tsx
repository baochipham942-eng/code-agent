// ============================================================================
// ProjectSpacePage —— 协作空间列表页 + 协作空间页（批P）。
// 壳：FullScreenPage inline（与能力中心/资料库同层级：左侧历史会话侧栏保留，本页渲染在
// 右侧内容区——爸 2026-07-29 拍板）；页内 useState 切 list/space 两视图（不进路由、不进 store），
// projectId=null 显示列表，点列表项进 space 视图，面包屑「协作空间」点回列表。
// ============================================================================

import React, { useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { useI18n } from '../../../hooks/useI18n';
import { ProjectListView } from './ProjectListView';
import { ProjectSpaceView } from './ProjectSpaceView';

export interface ProjectSpacePageProps {
  onClose: () => void;
}

export const ProjectSpacePage: React.FC<ProjectSpacePageProps> = ({ onClose }) => {
  const { t } = useI18n();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  return (
    <FullScreenPage testId="project-space-page" variant="inline">
      {selectedProjectId ? (
        <ProjectSpaceView
          projectId={selectedProjectId}
          onBackToList={() => setSelectedProjectId(null)}
        />
      ) : (
        <>
          <FullScreenPageHeader
            variant="bar"
            icon={<FolderKanban className="h-4 w-4 text-violet-300" />}
            title={t.projectSpace.listTitle}
            description={t.projectSpace.listDescription}
            onClose={onClose}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ProjectListView onSelect={setSelectedProjectId} />
          </div>
        </>
      )}
    </FullScreenPage>
  );
};

