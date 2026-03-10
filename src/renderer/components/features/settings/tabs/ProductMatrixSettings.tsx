// ============================================================================
// ProductMatrixSettings - Product Matrix Tab (Web / App / CLI)
// ============================================================================

import React, { useState, useMemo } from 'react';
import {
  Globe,
  Monitor,
  Terminal,
  ChevronDown,
  ChevronRight,
  Copy,
  Check,
  ExternalLink,
  ArrowRight,
} from 'lucide-react';

// ============================================================================
// Types
// ============================================================================

type Platform = 'macOS' | 'Windows' | 'Linux';

interface AccordionItemProps {
  title: string;
  subtitle: string;
  icon: React.ReactNode;
  defaultExpanded?: boolean;
  children: React.ReactNode;
}

// ============================================================================
// Helpers
// ============================================================================

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes('win')) return 'Windows';
  if (ua.includes('mac')) return 'macOS';
  return 'Linux';
}

const CopyButton: React.FC<{ text: string }> = ({ text }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
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
  );
};

const CommandLine: React.FC<{ label: string; command: string }> = ({ label, command }) => (
  <div className="space-y-1">
    <span className="text-xs text-zinc-400">{label}</span>
    <div className="flex items-center gap-2">
      <code className="flex-1 text-xs text-zinc-300 bg-zinc-800 px-2 py-1.5 rounded font-mono truncate">
        {command}
      </code>
      <CopyButton text={command} />
    </div>
  </div>
);

// ============================================================================
// AccordionItem
// ============================================================================

const AccordionItem: React.FC<AccordionItemProps> = ({
  title,
  subtitle,
  icon,
  defaultExpanded = false,
  children,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);

  return (
    <div className="bg-zinc-800 rounded-lg border border-zinc-700 overflow-hidden">
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="w-full flex items-center justify-between px-4 py-3 hover:bg-zinc-750 transition-colors"
      >
        <div className="flex items-center gap-3">
          {icon}
          <div className="text-left">
            <span className="text-sm font-medium text-zinc-200 block">{title}</span>
            <span className="text-xs text-zinc-500">{subtitle}</span>
          </div>
        </div>
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-400" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-400" />
        )}
      </button>
      {isExpanded && (
        <div className="px-4 pb-4 space-y-3 border-t border-zinc-700 pt-3">{children}</div>
      )}
    </div>
  );
};

// ============================================================================
// Component
// ============================================================================

export const ProductMatrixSettings: React.FC = () => {
  const platform = useMemo(() => detectPlatform(), []);

  // Helper to navigate to MCP tab (close settings then reopen)
  const handleGoToMCP = () => {
    // We dispatch a custom event that SettingsModal can listen to
    window.dispatchEvent(new CustomEvent('settings-navigate', { detail: { tab: 'mcp' } }));
  };

  const downloadLinks: Record<Platform, { label: string; url: string }> = {
    macOS: { label: '下载 .dmg', url: 'https://code-agent.dev/download/macos' },
    Windows: { label: '下载 .exe', url: 'https://code-agent.dev/download/windows' },
    Linux: { label: '下载 .deb', url: 'https://code-agent.dev/download/linux' },
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h3 className="text-sm font-medium text-zinc-200 mb-2">产品矩阵</h3>
        <p className="text-xs text-zinc-400 mb-4">
          Code Agent 提供多种使用方式，选择最适合你的形态。
        </p>
      </div>

      {/* Web */}
      <AccordionItem
        title="Web 端"
        subtitle="面向尝鲜用户"
        icon={<Globe className="w-5 h-5 text-blue-400" />}
        defaultExpanded
      >
        <div className="space-y-3">
          <div className="text-xs text-zinc-400 space-y-1.5">
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 零安装，打开浏览器即可使用
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 跨平台，任何设备都能访问
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 实时同步，多端数据自动同步
            </p>
          </div>
          <div className="bg-zinc-900 rounded-lg p-3 text-xs text-zinc-500">
            <p className="flex items-center gap-2">
              <span className="text-yellow-400">!</span> 需安装本地桥接服务才能操作本地文件
            </p>
          </div>
          <button
            onClick={handleGoToMCP}
            className="inline-flex items-center gap-1.5 text-xs text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            前往设置本地服务
            <ArrowRight className="w-3 h-3" />
          </button>
        </div>
      </AccordionItem>

      {/* App (Tauri) */}
      <AccordionItem
        title="App 端 (Tauri)"
        subtitle="面向希望完整体验的用户"
        icon={<Monitor className="w-5 h-5 text-purple-400" />}
      >
        <div className="space-y-3">
          <div className="text-xs text-zinc-400 space-y-1.5">
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 完整本地能力，无需桥接服务
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 原生性能，启动快、占用低
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 离线可用，无需网络连接
            </p>
          </div>
          <div className="flex items-center gap-2 mt-2">
            <span className="text-xs px-1.5 py-0.5 rounded bg-zinc-700 text-zinc-300">
              {platform}
            </span>
          </div>
          <a
            href={downloadLinks[platform].url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            {downloadLinks[platform].label}
            <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </AccordionItem>

      {/* CLI */}
      <AccordionItem
        title="CLI 端"
        subtitle="面向极客用户和其他 Agent"
        icon={<Terminal className="w-5 h-5 text-green-400" />}
      >
        <div className="space-y-3">
          <div className="text-xs text-zinc-400 space-y-1.5">
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 脚本自动化，批量操作
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> 管道集成，与其他命令行工具配合
            </p>
            <p className="flex items-center gap-2">
              <span className="text-green-400">✓</span> Agent 间调用，作为子 Agent 被编排
            </p>
          </div>
          <div className="space-y-3 mt-2">
            <CommandLine label="安装" command="npm install -g code-agent-cli" />
            <CommandLine label="更新" command="npm update -g code-agent-cli" />
            <CommandLine label="卸载" command="npm uninstall -g code-agent-cli" />
          </div>
        </div>
      </AccordionItem>
    </div>
  );
};
