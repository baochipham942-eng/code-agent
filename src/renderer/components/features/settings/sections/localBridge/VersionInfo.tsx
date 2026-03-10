// ============================================================================
// VersionInfo - Bridge Version Display with Update Prompt
// ============================================================================

import React, { useState } from 'react';
import { AlertTriangle, Copy, Check } from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

interface VersionInfoProps {
  version: string | null;
  latestVersion: string | null;
}

// ============================================================================
// Component
// ============================================================================

export const VersionInfo: React.FC<VersionInfoProps> = ({ version, latestVersion }) => {
  const [copied, setCopied] = useState(false);
  const hasUpdate = version && latestVersion && version !== latestVersion;
  const updateCommand = 'curl -fsSL https://code-agent.dev/install.sh | bash';

  const handleCopy = async () => {
    await navigator.clipboard.writeText(updateCommand);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-zinc-400">当前版本:</span>
        <span className="text-zinc-200 font-mono">{version || '未知'}</span>
      </div>
      {latestVersion && (
        <div className="flex items-center gap-4 text-sm">
          <span className="text-zinc-400">最新版本:</span>
          <span className="text-zinc-200 font-mono">{latestVersion}</span>
        </div>
      )}
      {hasUpdate && (
        <div className="mt-2 p-3 rounded-lg bg-yellow-500/10 border border-yellow-500/30">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-4 h-4 text-yellow-400" />
            <span className="text-sm text-yellow-400">有新版本可用</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 text-xs text-zinc-300 bg-zinc-800 px-2 py-1 rounded font-mono truncate">
              {updateCommand}
            </code>
            <button
              onClick={handleCopy}
              className="flex-shrink-0 p-1 rounded hover:bg-zinc-700 text-zinc-400 hover:text-zinc-200 transition-colors"
              title="复制命令"
            >
              {copied ? (
                <Check className="w-3.5 h-3.5 text-green-400" />
              ) : (
                <Copy className="w-3.5 h-3.5" />
              )}
            </button>
          </div>
          {copied && <span className="text-xs text-green-400 mt-1 block">已复制</span>}
        </div>
      )}
    </div>
  );
};
