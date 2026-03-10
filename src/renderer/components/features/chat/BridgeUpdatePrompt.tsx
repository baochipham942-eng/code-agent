// ============================================================================
// BridgeUpdatePrompt - Inline prompt when Bridge version is too low
// ============================================================================

import React from 'react';
import { ArrowUpCircle, Settings, X } from 'lucide-react';
import { Button } from '../../primitives';

interface BridgeUpdatePromptProps {
  currentVersion: string;
  requiredVersion: string;
  onGoToSettings: () => void;
  onDismiss: () => void;
}

export const BridgeUpdatePrompt: React.FC<BridgeUpdatePromptProps> = ({
  currentVersion,
  requiredVersion,
  onGoToSettings,
  onDismiss,
}) => {
  return (
    <div className="mx-6 my-2 rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 animate-fade-in">
      <div className="flex items-start gap-3">
        <div className="flex-shrink-0 mt-0.5">
          <ArrowUpCircle className="w-5 h-5 text-blue-400" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-medium text-blue-300 mb-1">
            桥接服务版本过低
          </h4>
          <p className="text-xs text-blue-200/70 leading-relaxed">
            当前版本{' '}
            <code className="px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono text-2xs">
              v{currentVersion}
            </code>
            ，需要{' '}
            <code className="px-1 py-0.5 rounded bg-blue-500/20 text-blue-300 font-mono text-2xs">
              v{requiredVersion}
            </code>{' '}
            或更高版本才能使用本地工具。请更新桥接服务。
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
          className="flex-shrink-0 p-1 rounded hover:bg-blue-500/20 text-blue-400/60 hover:text-blue-300 transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
};
