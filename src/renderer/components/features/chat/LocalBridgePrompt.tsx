// ============================================================================
// LocalBridgePrompt - Inline prompt when Bridge is not connected
// ============================================================================

import React from 'react';
import { AlertTriangle, Settings, X } from 'lucide-react';
import { Button } from '../../primitives';

interface LocalBridgePromptProps {
  toolName: string;
  onGoToSettings: () => void;
  onDismiss: () => void;
}

export const LocalBridgePrompt: React.FC<LocalBridgePromptProps> = ({
  toolName,
  onGoToSettings,
  onDismiss,
}) => {
  return (
    <div className="mx-6 my-2 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <AlertTriangle className="w-5 h-5 text-amber-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-amber-300 mb-1">
            需要本地桥接服务
          </h4>
          <p className="text-xs text-amber-200/70 leading-relaxed">
            工具 <code className="px-1 py-0.5 rounded bg-amber-500/20 text-amber-300 font-mono text-2xs">{toolName}</code> 需要访问本地文件系统，请先安装并启动桥接服务。
          </p>
          <div className="flex items-center gap-2 mt-3">
            <Button size="sm" variant="primary" onClick={onGoToSettings}>
              <Settings className="w-3.5 h-3.5 mr-1.5" />
              前往设置
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismiss}>
              取消
            </Button>
          </div>
        </div>
        <button
          onClick={onDismiss}
          className="flex-shrink-0 p-1 rounded hover:bg-amber-500/20 text-amber-400/60 hover:text-amber-300 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
