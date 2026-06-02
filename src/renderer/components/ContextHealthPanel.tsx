// ============================================================================
// ContextHealthPanel - 上下文健康度指示器
// 显示当前会话的 token 使用情况
// ============================================================================

import React, { useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  Activity,
  AlertTriangle,
  AlertCircle,
  Sparkles,
  ExternalLink,
  X as XIcon,
} from 'lucide-react';
import type {
  ContextHealthState,
  ContextHealthWarningLevel,
  SourceTag,
} from '@shared/contract/contextHealth';

interface ContextHealthPanelProps {
  health: ContextHealthState | null;
  collapsed?: boolean;
  onToggle?: () => void;
  /** 点击某 source 的跳转图标时调（step 10 会接 SkillsPanel highlight） */
  onNavigate?: (target: SourceTag) => void;
  /** 点击某 source 的卸载/禁用图标时调（step 10 接 SkillsPanel.unmount / MCP.disable） */
  onUnload?: (target: SourceTag) => void;
}

/**
 * 格式化 token 数量（添加千分位分隔符）
 */
function formatTokens(tokens: number): string {
  return tokens.toLocaleString();
}

/**
 * 获取警告级别对应的颜色配置
 */
function getWarningColors(level: ContextHealthWarningLevel) {
  switch (level) {
    case 'critical':
      return {
        icon: AlertCircle,
        iconColor: 'text-red-400',
        barColor: 'bg-red-500',
        bgColor: 'bg-red-500/10',
        textColor: 'text-red-400',
      };
    case 'warning':
      return {
        icon: AlertTriangle,
        iconColor: 'text-yellow-400',
        barColor: 'bg-yellow-500',
        bgColor: 'bg-yellow-500/10',
        textColor: 'text-yellow-400',
      };
    default:
      return {
        icon: Activity,
        iconColor: 'text-emerald-400',
        barColor: 'bg-emerald-500',
        bgColor: '',
        textColor: 'text-zinc-400',
      };
  }
}

export const ContextHealthPanel: React.FC<ContextHealthPanelProps> = ({
  health,
  collapsed = true,
  onToggle,
  onNavigate,
  onUnload,
}) => {
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showBySource, setShowBySource] = useState(true);
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({
    skills: true,
    mcp: true,
    subagents: false,
  });

  const toggleGroup = (key: string) => {
    setExpandedGroups((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // 如果没有健康数据，不渲染
  if (!health) {
    return null;
  }

  const colors = getWarningColors(health.warningLevel);
  const IconComponent = colors.icon;

  const handleToggle = () => {
    const newExpanded = !isExpanded;
    setIsExpanded(newExpanded);
    onToggle?.();
  };

  return (
    <div className={`border-b border-zinc-700 ${colors.bgColor}`}>
      {/* 头部 - 可点击折叠 */}
      <button
        onClick={handleToggle}
        className="w-full flex items-center gap-2 p-3 hover:bg-zinc-800 transition-colors"
      >
        {isExpanded ? (
          <ChevronDown className="w-4 h-4 text-zinc-500" />
        ) : (
          <ChevronRight className="w-4 h-4 text-zinc-500" />
        )}
        <IconComponent className={`w-4 h-4 ${colors.iconColor}`} />
        <span className="text-sm font-medium text-zinc-200">上下文健康度</span>
        <span className={`ml-auto text-sm font-mono ${colors.textColor}`}>
          {health.usagePercent.toFixed(1)}%
        </span>
      </button>

      {/* 展开内容 */}
      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* 进度条 */}
          <div className="space-y-1.5">
            <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
              <div
                className={`h-full ${colors.barColor} transition-all duration-300`}
                style={{ width: `${Math.min(health.usagePercent, 100)}%` }}
              />
            </div>
            <div className="flex justify-between text-xs">
              <span className="text-zinc-400 font-mono">
                {formatTokens(health.currentTokens)} / {formatTokens(health.maxTokens)} tokens
              </span>
            </div>
          </div>

          {/* 分解详情 - 可展开 */}
          <div>
            <button
              onClick={() => setShowBreakdown(!showBreakdown)}
              className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
            >
              {showBreakdown ? (
                <ChevronDown className="w-3 h-3" />
              ) : (
                <ChevronRight className="w-3 h-3" />
              )}
              <span>Token 分解</span>
            </button>

            {showBreakdown && (
              <div className="mt-2 space-y-1.5 pl-4">
                <BreakdownItem
                  label="System Prompt"
                  tokens={health.breakdown.systemPrompt}
                  total={health.currentTokens}
                />
                <BreakdownItem
                  label="Messages"
                  tokens={health.breakdown.messages}
                  total={health.currentTokens}
                />
                <BreakdownItem
                  label="Tool Results"
                  tokens={health.breakdown.toolResults}
                  total={health.currentTokens}
                />
                {health.breakdown.toolDefinitions !== undefined && (
                  <BreakdownItem
                    label="Tool Defs"
                    tokens={health.breakdown.toolDefinitions}
                    total={health.currentTokens}
                  />
                )}
              </div>
            )}
          </div>

          {/* 按产品来源拆分（bySource）—— 与上面"消息结构"是不同维度 */}
          {health.breakdown.bySource && (
            <div className="border-t border-zinc-700/60 pt-3">
              <button
                onClick={() => setShowBySource(!showBySource)}
                className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition-colors"
              >
                {showBySource ? (
                  <ChevronDown className="w-3 h-3" />
                ) : (
                  <ChevronRight className="w-3 h-3" />
                )}
                <span>按产品来源</span>
              </button>

              {showBySource && (
                <div className="mt-2 space-y-1.5 pl-4">
                  {/* Rules — 标量 */}
                  <BreakdownItem
                    label="Rules"
                    tokens={health.breakdown.bySource.rules}
                    total={health.currentTokens}
                  />

                  {/* Skills — Record 嵌套折叠 */}
                  <NestedGroup
                    label="Skills"
                    entries={health.breakdown.bySource.skills}
                    total={health.currentTokens}
                    isExpanded={expandedGroups.skills}
                    onToggle={() => toggleGroup('skills')}
                    sourceFactory={(name) => ({ type: 'skill', name })}
                    onNavigate={onNavigate}
                    onUnload={onUnload}
                  />

                  {/* MCP — Record 嵌套折叠 */}
                  <NestedGroup
                    label="MCP"
                    entries={health.breakdown.bySource.mcp}
                    total={health.currentTokens}
                    isExpanded={expandedGroups.mcp}
                    onToggle={() => toggleGroup('mcp')}
                    sourceFactory={(server) => ({ type: 'mcp', server })}
                    onNavigate={onNavigate}
                    onUnload={onUnload}
                  />

                  {/* Subagents — Record 嵌套折叠 */}
                  <NestedGroup
                    label="Subagents"
                    entries={health.breakdown.bySource.subagents}
                    total={health.currentTokens}
                    isExpanded={expandedGroups.subagents}
                    onToggle={() => toggleGroup('subagents')}
                    sourceFactory={(name) => ({ type: 'subagent', name })}
                    onNavigate={onNavigate}
                    onUnload={onUnload}
                  />

                  {/* File Reads — 标量 */}
                  <BreakdownItem
                    label="File Reads"
                    tokens={health.breakdown.bySource.fileReads}
                    total={health.currentTokens}
                  />

                  {/* Conversation — 派生值 */}
                  <BreakdownItem
                    label="Conversation"
                    tokens={health.breakdown.bySource.conversation}
                    total={health.currentTokens}
                  />
                </div>
              )}
            </div>
          )}

          {/* 预估剩余轮数 */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Sparkles className="w-3 h-3" />
            <span>
              预估剩余:{' '}
              <span className="text-zinc-400">~{health.estimatedTurnsRemaining} 轮</span>
            </span>
          </div>

          {/* GAP-023: 被预算丢弃的 prompt 块（能力可见化——agent 能力缩水时用户能看到原因） */}
          {(health.droppedPromptBlocks?.length ?? 0) > 0 && (
            <div className="flex items-start gap-2 p-2 bg-orange-500/20 rounded-md">
              <AlertTriangle className="w-4 h-4 text-orange-400 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-orange-300 space-y-1">
                <div>以下上下文块因 system prompt 预算超限被丢弃，agent 部分能力可能不可见：</div>
                <div className="flex flex-wrap gap-1">
                  {health.droppedPromptBlocks?.map((block) => (
                    <span
                      key={block}
                      className="px-1.5 py-0.5 bg-orange-500/20 rounded font-mono text-orange-200"
                    >
                      {block}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* 警告提示 */}
          {health.warningLevel === 'critical' && (
            <div className="flex items-center gap-2 p-2 bg-red-500/20 rounded-md">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <span className="text-xs text-red-300">
                上下文即将耗尽，建议开启新会话或压缩上下文
              </span>
            </div>
          )}

          {health.warningLevel === 'warning' && (
            <div className="flex items-center gap-2 p-2 bg-yellow-500/20 rounded-md">
              <AlertTriangle className="w-4 h-4 text-yellow-400 flex-shrink-0" />
              <span className="text-xs text-yellow-300">
                上下文使用率较高，请注意控制对话长度
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/**
 * Token 分解项
 */
const BreakdownItem: React.FC<{
  label: string;
  tokens: number;
  total: number;
}> = ({ label, tokens, total }) => {
  const percent = total > 0 ? ((tokens / total) * 100).toFixed(1) : '0.0';

  return (
    <div className="flex justify-between text-xs">
      <span className="text-zinc-500">{label}</span>
      <span className="text-zinc-400 font-mono">
        {formatTokens(tokens)} ({percent}%)
      </span>
    </div>
  );
};

/**
 * 嵌套分组：Skills / MCP / Subagents 共用
 * 标题行显示总和 + 活跃数；展开后逐 entry 列出 + 跳转 / 卸载图标
 */
const NestedGroup: React.FC<{
  label: string;
  entries: Record<string, number>;
  total: number;
  isExpanded: boolean;
  onToggle: () => void;
  sourceFactory: (name: string) => SourceTag;
  onNavigate?: (target: SourceTag) => void;
  onUnload?: (target: SourceTag) => void;
}> = ({ label, entries, total, isExpanded, onToggle, sourceFactory, onNavigate, onUnload }) => {
  const names = Object.keys(entries);
  const sum = Object.values(entries).reduce((a, b) => a + b, 0);
  const percent = total > 0 ? ((sum / total) * 100).toFixed(1) : '0.0';
  const hasEntries = names.length > 0;

  return (
    <div className="space-y-1">
      <button
        onClick={hasEntries ? onToggle : undefined}
        disabled={!hasEntries}
        className={`flex w-full items-center justify-between text-xs ${
          hasEntries ? 'cursor-pointer hover:text-zinc-300' : 'cursor-default'
        }`}
      >
        <span className="flex items-center gap-1 text-zinc-500">
          {hasEntries ? (
            isExpanded ? (
              <ChevronDown className="w-3 h-3" />
            ) : (
              <ChevronRight className="w-3 h-3" />
            )
          ) : (
            <span className="w-3 h-3" />
          )}
          {label}
          {hasEntries && (
            <span className="ml-1 text-zinc-600">●{names.length}</span>
          )}
        </span>
        <span className="text-zinc-400 font-mono">
          {formatTokens(sum)} ({percent}%)
        </span>
      </button>
      {isExpanded && hasEntries && (
        <div className="space-y-0.5 pl-4">
          {names
            .sort((a, b) => entries[b] - entries[a])
            .map((name) => {
              const source = sourceFactory(name);
              return (
                <div
                  key={name}
                  className="group flex items-center justify-between text-xs"
                >
                  <span className="truncate text-zinc-500" title={name}>
                    {name}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-zinc-400 font-mono">
                      {formatTokens(entries[name])}
                    </span>
                    {onNavigate && (
                      <button
                        type="button"
                        onClick={() => onNavigate(source)}
                        className="opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
                        title="跳转到对应面板"
                      >
                        <ExternalLink className="w-3 h-3 text-zinc-500" />
                      </button>
                    )}
                    {onUnload && (
                      <button
                        type="button"
                        onClick={() => onUnload(source)}
                        className="opacity-0 group-hover:opacity-70 hover:opacity-100 transition-opacity"
                        title="卸载 / 断开"
                      >
                        <XIcon className="w-3 h-3 text-zinc-500 hover:text-red-400" />
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
        </div>
      )}
    </div>
  );
};

export default ContextHealthPanel;
