// ============================================================================
// ProjectSpacePage —— 项目列表页 + 项目协作空间页（批P）。
// 壳：FullScreenPage overlay；页内 useState 切 list/space 两视图（不进路由、不进 store），
// projectId=null 显示列表，点列表项进 space 视图，面包屑「项目」点回列表。
// ============================================================================

import React, { useState } from 'react';
import { FolderKanban } from 'lucide-react';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { useI18n } from '../../../hooks/useI18n';
import { ProjectListView } from './ProjectListView';

export interface ProjectSpacePageProps {
  onClose: () => void;
}

export const ProjectSpacePage: React.FC<ProjectSpacePageProps> = ({ onClose }) => {
  const { t } = useI18n();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);

  return (
    <FullScreenPage testId="project-space-page">
      {selectedProjectId ? (
        // space 视图占位：下一批接入 ProjectSpaceView（页头+三 tab+右栏）
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3">
          <span className="text-sm text-zinc-500">{selectedProjectId}</span>
          <button /* ds-allow:button: 占位返回链接，下一批随 space 视图一起替换 */
            type="button"
            onClick={() => setSelectedProjectId(null)}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            {t.projectSpace.backToList}
          </button>
        </div>
      ) : (
        <>
          <FullScreenPageHeader
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

export default ProjectSpacePage;
