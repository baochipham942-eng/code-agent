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
  Shrink,
  Loader2,
} from 'lucide-react';
import type {
  ContextHealthState,
  ContextHealthWarningLevel,
  SourceTag,
} from '@shared/contract/contextHealth';
import { useI18n } from '../hooks/useI18n';
import {
  bucketSharePercent,
  clampUsagePercent,
  isContextWindowKnown,
} from '../utils/contextUsageFormat';
import { interpolate } from '../i18n/interpolate';

interface ContextHealthPanelProps {
  health: ContextHealthState | null;
  collapsed?: boolean;
  onToggle?: () => void;
  /** 点击某 source 的跳转图标时调（step 10 会接 SkillsPanel highlight） */
  onNavigate?: (target: SourceTag) => void;
  /** 点击某 source 的卸载/禁用图标时调（step 10 接 SkillsPanel.unmount / MCP.disable） */
  onUnload?: (target: SourceTag) => void;
  /** critical 时展示「立即压缩」按钮；未传时不渲染按钮（纯展示模式，组件不知道 IPC 存在） */
  onCompact?: () => void;
  /** 压缩进行中——按钮 disabled，避免重复触发 */
  isCompacting?: boolean;
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
        iconColor: 'text-badge-danger',
        barColor: 'bg-red-500',
        bgColor: 'bg-red-500/10',
        textColor: 'text-badge-danger',
      };
    case 'warning':
      return {
        icon: AlertTriangle,
        iconColor: 'text-badge-warning',
        barColor: 'bg-yellow-500',
        bgColor: 'bg-yellow-500/10',
        textColor: 'text-badge-warning',
      };
    default:
      return {
        icon: Activity,
        iconColor: 'text-badge-success',
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
  onCompact,
  isCompacting = false,
}) => {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const [isExpanded, setIsExpanded] = useState(!collapsed);
  const [showBreakdown, setShowBreakdown] = useState(false);
  const [showBySource, setShowBySource] = useState(true);
  const [showDroppedBlocks, setShowDroppedBlocks] = useState(false);
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
  const windowKnown = isContextWindowKnown(health);
  const displayPercent = windowKnown ? clampUsagePercent(health.usagePercent) : 0;
  const structureTotal = [
    health.breakdown.systemPrompt,
    health.breakdown.messages,
    health.breakdown.toolResults,
    health.breakdown.toolDefinitions ?? 0,
  ].reduce((sum, tokens) => sum + Math.max(0, tokens), 0);
  const sourceEntries = health.breakdown.bySource;
  const sourceTotal = sourceEntries
    ? (sourceEntries.rules
      + Object.values(sourceEntries.skills).reduce((sum, tokens) => sum + tokens, 0)
      + Object.values(sourceEntries.mcp).reduce((sum, tokens) => sum + tokens, 0)
      + Object.values(sourceEntries.subagents).reduce((sum, tokens) => sum + tokens, 0)
      + sourceEntries.fileReads
      + (sourceEntries.summary ?? 0)
      + (sourceEntries.conversation ?? 0))
    : 0;


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
        <span className="text-sm font-medium text-zinc-200">{ch.title}</span>
        <span
          className={`ml-auto text-sm font-mono ${colors.textColor}`}
          data-testid="context-health-panel-percent"
        >
          {windowKnown ? `${displayPercent.toFixed(1)}%` : ch.windowUnknownSummary}
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
                  data-testid="context-health-panel-bar"
                  style={{ width: `${displayPercent}%` }}
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
              <span>{ch.tokenBreakdown}</span>
            </button>

            {showBreakdown && (
              <div className="mt-2 space-y-1.5 pl-4">
                <BreakdownItem
                  label={ch.bkSystemPrompt}
                  tokens={health.breakdown.systemPrompt}
                  total={structureTotal}
                />
                <BreakdownItem
                  label={ch.bkMessages}
                  tokens={health.breakdown.messages}
                  total={structureTotal}
                />
                <BreakdownItem
                  label={ch.bkToolResults}
                  tokens={health.breakdown.toolResults}
                  total={structureTotal}
                />
                {health.breakdown.toolDefinitions !== undefined && (
                  <BreakdownItem
                    label={ch.bkToolDefs}
                    tokens={health.breakdown.toolDefinitions}
                    total={structureTotal}
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
                <span>{ch.bySource}</span>
              </button>

              {showBySource && (
                <div className="mt-2 space-y-1.5 pl-4">
                  {/* Rules — 标量 */}
                  <BreakdownItem
                    label={ch.bkRules}
                    tokens={health.breakdown.bySource.rules}
                    total={sourceTotal}
                  />

                  {/* Skills — Record 嵌套折叠 */}
                  <NestedGroup
                    label="Skills"
                    entries={health.breakdown.bySource.skills}
                    total={sourceTotal}
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
                    total={sourceTotal}
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
                    total={sourceTotal}
                    isExpanded={expandedGroups.subagents}
                    onToggle={() => toggleGroup('subagents')}
                    sourceFactory={(name) => ({ type: 'subagent', name })}
                    onNavigate={onNavigate}
                    onUnload={onUnload}
                  />

                  {/* File Reads — 标量 */}
                  <BreakdownItem
                    label={ch.bkFileReads}
                    tokens={health.breakdown.bySource.fileReads}
                    total={sourceTotal}
                  />

                  {/* Summary — 派生值：压缩摘要消息估算，仅在压过之后渲染 */}
                  {(health.breakdown.bySource.summary ?? 0) > 0 && (
                    <BreakdownItem
                      label={ch.bkSummary.replace(
                        '{count}',
                        String(health.compression?.compressionCount ?? 0),
                      )}
                      tokens={health.breakdown.bySource.summary}
                      total={sourceTotal}
                    />
                  )}

                  {/* Conversation — 派生值 */}
                  <BreakdownItem
                    label={ch.bkConversation}
                    tokens={health.breakdown.bySource.conversation}
                    total={sourceTotal}
                  />
                </div>
              )}
            </div>
          )}

          {/* 预估剩余轮数 */}
          <div className="flex items-center gap-1.5 text-xs text-zinc-500">
            <Sparkles className="w-3 h-3" />
            <span>
              {ch.estimatedRemaining}{' '}
              <span className="text-zinc-400">{interpolate(ch.turnsRemaining, { count: health.estimatedTurnsRemaining })}</span>
            </span>
          </div>

          {/* GAP-023: 被预算丢弃的 prompt 块（能力可见化——agent 能力缩水时用户能看到原因） */}
          {(health.droppedPromptBlocks?.length ?? 0) > 0 && (
            <div className="flex items-start gap-2 p-2 bg-orange-500/20 rounded-md">
              <AlertTriangle className="w-4 h-4 text-badge-warning flex-shrink-0 mt-0.5" />
              <div className="min-w-0 flex-1 text-xs text-badge-warning space-y-1">
                <div className="flex items-center justify-between gap-2">
                  <span>{ch.droppedBlocks} {health.droppedPromptBlocks?.length}</span>
                  <button
                    type="button"
                    onClick={() => setShowDroppedBlocks((value) => !value)}
                    aria-expanded={showDroppedBlocks}
                    className="shrink-0 text-badge-warning/70 hover:text-badge-warning transition-colors"
                  >
                    {showDroppedBlocks ? t.systemError.hideDetails : t.systemError.viewDetails}
                  </button>
                </div>
                {showDroppedBlocks && (
                  <div className="flex flex-wrap gap-1">
                    {health.droppedPromptBlocks?.map((block) => (
                      <span
                        key={block}
                        className="px-1.5 py-0.5 bg-orange-500/20 rounded font-mono text-badge-warning"
                      >
                        {block}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 警告提示 */}
          {health.warningLevel === 'critical' && (
            <div className="flex items-center gap-2 p-2 bg-red-500/20 rounded-md">
              <AlertCircle className="w-4 h-4 text-badge-danger flex-shrink-0" />
              <span className="flex-1 text-xs text-badge-danger">
                {ch.nearlyExhausted}
              </span>
              {onCompact && (
                <button
                  type="button"
                  onClick={onCompact}
                  disabled={isCompacting}
                  title={ch.compactHint}
                  className="shrink-0 inline-flex items-center gap-1 rounded-md border border-badge-danger/30 bg-red-500/10 px-2 py-1 text-xs font-medium text-badge-danger transition-colors hover:bg-red-500/20 disabled:cursor-wait disabled:opacity-70"
                >
                  {isCompacting ? (
                    <Loader2 className="w-3 h-3 animate-spin" />
                  ) : (
                    <Shrink className="w-3 h-3" />
                  )}
                  {isCompacting ? ch.compacting : ch.compactNow}
                </button>
              )}
            </div>
          )}

          {health.warningLevel === 'warning' && (
            <div className="flex items-center gap-2 p-2 bg-yellow-500/20 rounded-md">
              <AlertTriangle className="w-4 h-4 text-badge-warning flex-shrink-0" />
              <span className="text-xs text-badge-warning">
                {ch.highUsage}
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
 * 0 值桶不渲染（Cursor 面板同款：只占位的空桶会让用户以为数据坏了）
 */
const BreakdownItem: React.FC<{
  label: string;
  tokens: number;
  total: number;
}> = ({ label, tokens, total }) => {
  if (tokens <= 0) return null;
  const percent = bucketSharePercent(tokens, total).toFixed(1);

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
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const names = Object.keys(entries);
  const sum = Object.values(entries).reduce((a, b) => a + b, 0);
  // 空桶不占位（与 BreakdownItem 同一口径：0 值不渲染）
  if (sum <= 0) return null;
  const percent = bucketSharePercent(sum, total).toFixed(1);
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
                        aria-label={interpolate(ch.jumpToPanelAria, { name })}
                        className="opacity-0 group-hover:opacity-70 hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity"
                        title={ch.jumpToPanel}
                      >
                        <ExternalLink className="w-3 h-3 text-zinc-500" />
                      </button>
                    )}
                    {onUnload && (
                      <button
                        type="button"
                        onClick={() => onUnload(source)}
                        aria-label={interpolate(ch.unmountAria, { name })}
                        className="opacity-0 group-hover:opacity-70 hover:opacity-100 focus-visible:opacity-100 group-focus-within:opacity-100 transition-opacity"
                        title={ch.unmountDisconnect}
                      >
                        <XIcon className="w-3 h-3 text-zinc-500 hover:text-badge-danger" />
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

