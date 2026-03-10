// ============================================================================
// LocalBridgeSection - Accordion Container for Local Bridge Service
// ============================================================================

import React, { useState, useEffect } from 'react';
import { ChevronDown, ChevronRight, Server } from 'lucide-react';
import { useLocalBridgeStore } from '../../../../../stores/localBridgeStore';
import { StatusIndicator } from './StatusIndicator';
import { VersionInfo } from './VersionInfo';
import { InstallGuide } from './InstallGuide';
import { WorkingDirectoryPicker } from './WorkingDirectoryPicker';
import { SecurityLevelConfig } from './SecurityLevelConfig';

// ============================================================================
// Component
// ============================================================================

export const LocalBridgeSection: React.FC = () => {
  const [isExpanded, setIsExpanded] = useState(true);
  const { status, version, latestVersion, startPolling, stopPolling } = useLocalBridgeStore();

  useEffect(() => {
    startPolling();
    return () => stopPolling();
  }, [startPolling, stopPolling]);

  const isConnected = status === 'connected';

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      {/* Accordion Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          <Server className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-medium text-zinc-200">本地桥接服务</span>
          <StatusIndicator status={status} />
        </div>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        )}
      </button>

      {/* Accordion Body */}
      {isExpanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-zinc-700 pt-4">
          {isConnected ? (
            <>
              <VersionInfo version={version} latestVersion={latestVersion} />
              <WorkingDirectoryPicker />
              <SecurityLevelConfig />
            </>
          ) : (
            <>
              <p className="text-xs text-zinc-400">
                本地桥接服务允许 Web 端操作本地文件系统。安装后即可在浏览器中使用完整的文件操作能力。
              </p>
              <InstallGuide />
            </>
          )}
        </div>
      )}
    </div>
  );
};
