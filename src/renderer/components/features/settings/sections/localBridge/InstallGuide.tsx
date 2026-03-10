// ============================================================================
// InstallGuide - Platform-Specific Installation Instructions
// ============================================================================

import React, { useState, useMemo } from 'react';
import { Copy, Check, ChevronDown, ChevronRight } from 'lucide-react';

// ============================================================================
// Helpers
// ============================================================================

type Platform = 'macOS' | 'Windows' | 'Linux';

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'Windows';
  if (ua.includes('mac')) return 'macOS';
  return 'Linux';
}

interface CommandBlockProps {
  label: string;
  command: string;
}

const CommandBlock: React.FC<CommandBlockProps> = ({ label, command }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(command);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-1">
      <span className="text-xs text-zinc-400">{label}</span>
      <div className="flex items-center gap-2">
        <code className="flex-1 text-xs text-zinc-300 bg-zinc-800 px-2 py-1.5 rounded font-mono truncate">
          {command}
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
      {copied && <span className="text-xs text-green-400">已复制</span>}
    </div>
  );
};

// ============================================================================
// Component
// ============================================================================

export const InstallGuide: React.FC = () => {
  const [showMore, setShowMore] = useState(false);
  const platform = useMemo(() => detectPlatform(), []);

  const installCommands: Record<Platform, string> = {
    macOS: 'curl -fsSL https://code-agent.dev/install.sh | bash',
    Linux: 'curl -fsSL https://code-agent.dev/install.sh | bash',
    Windows: 'irm https://code-agent.dev/install.ps1 | iex',
  };

  const updateCommands: Record<Platform, string> = {
    macOS: 'curl -fsSL https://code-agent.dev/install.sh | bash',
    Linux: 'curl -fsSL https://code-agent.dev/install.sh | bash',
    Windows: 'irm https://code-agent.dev/install.ps1 | iex',
  };

  const uninstallCommands: Record<Platform, string> = {
    macOS: 'curl -fsSL https://code-agent.dev/uninstall.sh | bash',
    Linux: 'curl -fsSL https://code-agent.dev/uninstall.sh | bash',
    Windows: 'irm https://code-agent.dev/uninstall.ps1 | iex',
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-300">
          {platform}
        </span>
        <span className="text-xs text-zinc-500">自动检测</span>
      </div>

      <CommandBlock label="安装" command={installCommands[platform]} />

      <button
        onClick={() => setShowMore(!showMore)}
        className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
      >
        {showMore ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
        更新 & 卸载
      </button>

      {showMore && (
        <div className="space-y-3 pl-2 border-l-2 border-zinc-700">
          <CommandBlock label="更新" command={updateCommands[platform]} />
          <CommandBlock label="卸载" command={uninstallCommands[platform]} />
        </div>
      )}
    </div>
  );
};
