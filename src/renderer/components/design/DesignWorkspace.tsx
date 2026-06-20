// 设计工作区（Kun 借鉴：设计 tab）。全屏覆盖在 Code 之上，复用 FullScreenPage
// 范式。B1 阶段为骨架：表头含 Code/设计 切换器（切回 Code），主体占位；
// 输入表单 + 原型生成 + 预览在 B2/B3 填充。
import React from 'react';
import { Palette } from 'lucide-react';
import { FullScreenPage } from '../features/shared/FullScreenPage';
import { WorkspaceModeSwitch } from './WorkspaceModeSwitch';
import { useI18n } from '../../hooks/useI18n';

export const DesignWorkspace: React.FC = () => {
  const { t } = useI18n();
  return (
    <FullScreenPage testId="design-workspace">
      <div className="flex items-center justify-between border-b border-white/[0.06] px-4 h-12 shrink-0">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-fuchsia-300" />
          <span className="text-sm text-zinc-200">{t.design.title}</span>
        </div>
        <WorkspaceModeSwitch />
      </div>
      <div className="flex-1 min-h-0 flex items-center justify-center text-zinc-500 text-sm">
        {t.design.comingSoon}
      </div>
    </FullScreenPage>
  );
};
