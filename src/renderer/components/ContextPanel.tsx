// ============================================================================
// ContextPanel - 右侧 Context Tab 容器
// 挂载 ContextHealthPanel 并提供面板级 padding/scroll
// ============================================================================

import React from 'react';
import { useAppStore } from '../stores/appStore';
import { ContextHealthPanel } from './ContextHealthPanel';

export const ContextPanel: React.FC = () => {
  const contextHealth = useAppStore((s) => s.contextHealth);

  return (
    <div className="h-full overflow-y-auto bg-zinc-950">
      {contextHealth ? (
        <ContextHealthPanel health={contextHealth} collapsed={false} />
      ) : (
        <div className="p-6 text-sm text-zinc-500">
          <p>暂无上下文数据。</p>
          <p className="mt-2 text-xs text-zinc-600">
            发送一条消息或挂载 skill / MCP 后会自动出现。
          </p>
        </div>
      )}
    </div>
  );
};

export default ContextPanel;
