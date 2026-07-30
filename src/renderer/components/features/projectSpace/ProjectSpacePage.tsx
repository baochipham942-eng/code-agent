// ============================================================================
// ProjectSpacePage —— 协作空间列表页 + 协作空间页（批P）。
// 壳：FullScreenPage inline（与能力中心/资料库同层级：左侧历史会话侧栏保留，本页渲染在
// 右侧内容区——爸 2026-07-29 拍板）；页内 useState 切 list/space 两视图（不进路由、不进 store），
// projectId=null 显示列表，点列表项进 space 视图，面包屑「协作空间」点回列表。
// ============================================================================

import React, { useRef, useState } from 'react';
import { FolderKanban, Plus } from 'lucide-react';
import { FullScreenPage, FullScreenPageHeader } from '../shared/FullScreenPage';
import { useI18n } from '../../../hooks/useI18n';
import { ProjectListView, type ProjectListViewHandle } from './ProjectListView';
import { PrimaryButton } from '../../primitives/Button';
import { ProjectSpaceView } from './ProjectSpaceView';

export interface ProjectSpacePageProps {
  onClose: () => void;
}

export const ProjectSpacePage: React.FC<ProjectSpacePageProps> = ({ onClose }) => {
  const { t } = useI18n();
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const listRef = useRef<ProjectListViewHandle>(null);

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
            // 「新建空间」住页头 actions 槽（规范位，爸 2026-07-30：按钮别在内容区乱飘）
            actions={(
              <PrimaryButton
                size="sm"
                leftIcon={<Plus className="h-3.5 w-3.5" />}
                data-testid="project-space-create-open"
                onClick={() => listRef.current?.openCreate()}
              >
                {t.projectSpace.createSpace}
              </PrimaryButton>
            )}
          />
          <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-6">
            <ProjectListView ref={listRef} onSelect={setSelectedProjectId} />
          </div>
        </>
      )}
    </FullScreenPage>
  );
};

