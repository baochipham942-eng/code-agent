// ============================================================================
// MessageBubble - Individual Chat Message Display
// ============================================================================
// Routes messages to the appropriate component based on role.
// Both developer and cowork modes now use the same terminal-style display.
// ============================================================================

import React, { useState, useCallback } from 'react';
import { ChevronDown, ChevronRight, Archive } from 'lucide-react';
import type { CompactionBlock, CompactionSurvivorFile, CompactionSurvivorItem } from '@shared/contract';
import type { MessageBubbleProps } from './types';
import { UserMessage } from './UserMessage';
import { AssistantMessage } from './AssistantMessage';
import { SkillStatusMessage, isSkillStatusContent } from './SkillStatusMessage';
import { GoalNoticeMessage } from './GoalNoticeMessage';
import { isGoalNoticeContent } from '../goalNotice';
import { useMessageActionStore } from '../../../../stores/messageActionStore';

const COMPACTION_SOURCE_LABELS: Partial<Record<NonNullable<CompactionBlock['source']>, string>> = {
  manual_current: 'manual current',
  manual_from_message: 'manual from message',
  auto_threshold: 'auto threshold',
  overflow_recovery: 'overflow recovery',
};

const formatCompactionSource = (source?: CompactionBlock['source']): string | null => {
  if (!source) return null;
  return COMPACTION_SOURCE_LABELS[source] ?? source;
};

const formatProviderModel = (provider?: string, model?: string): string | null => {
  if (provider && model) return `${provider}/${model}`;
  return provider ?? model ?? null;
};

const compactPath = (path: string): string => {
  const parts = path.split('/').filter(Boolean);
  if (parts.length <= 2) return path;
  return `.../${parts.slice(-2).join('/')}`;
};

const compactItemText = (item: CompactionSurvivorItem): string => {
  const detail = item.detail?.trim();
  if (!detail) return item.label;
  return `${item.label}: ${detail}`;
};

const isSurvivorFile = (
  item: CompactionSurvivorFile | CompactionSurvivorItem | string,
): item is CompactionSurvivorFile => (
  typeof item === 'object' && item !== null && 'path' in item
);

const CompactionMetaPill: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <span className="inline-flex items-center gap-1 rounded border border-amber-500/15 bg-amber-500/5 px-1.5 py-0.5 text-[10px] leading-4 text-amber-200/85">
    <span className="text-amber-300/65">{label}</span>
    <span className="max-w-44 truncate">{value}</span>
  </span>
);

const CompactionDetailList: React.FC<{
  label: string;
  items: Array<CompactionSurvivorFile | CompactionSurvivorItem | string>;
  renderItem: (item: CompactionSurvivorFile | CompactionSurvivorItem | string) => { text: string; title?: string };
}> = ({ label, items, renderItem }) => {
  if (!items.length) return null;

  const visible = items.slice(0, 3);
  const remaining = items.length - visible.length;

  return (
    <div className="min-w-0">
      <div className="mb-1 text-[10px] font-medium uppercase text-amber-300/70">
        {label} {items.length}
      </div>
      <ul className="space-y-0.5">
        {visible.map((item, index) => {
          const rendered = renderItem(item);
          return (
            <li
              key={`${label}-${index}-${rendered.text}`}
              title={rendered.title ?? rendered.text}
              className="truncate text-[11px] leading-4 text-zinc-400"
            >
              {rendered.text}
            </li>
          );
        })}
        {remaining > 0 && (
          <li className="text-[11px] leading-4 text-zinc-500">+{remaining} more</li>
        )}
      </ul>
    </div>
  );
};

// CompactionBlock 渲染组件（折叠摘要卡片）
const CompactionBlockDisplay: React.FC<{ message: MessageBubbleProps['message'] }> = ({ message }) => {
  const [expanded, setExpanded] = useState(false);
  const compaction = message.compaction;

  if (!compaction) return null;

  const source = formatCompactionSource(compaction.source);
  const providerModel = formatProviderModel(compaction.provider, compaction.model);
  const warnings = compaction.warnings ?? [];
  const manifest = compaction.survivorManifest;
  const files = [...(manifest?.files ?? []), ...(manifest?.artifacts ?? [])];
  const errors = manifest?.errors ?? [];
  const openWork = manifest?.openWork ?? [];
  const manifestCounts = [
    files.length > 0 ? `files ${files.length}` : null,
    errors.length > 0 ? `errors ${errors.length}` : null,
    openWork.length > 0 ? `open ${openWork.length}` : null,
  ].filter(Boolean).join(' · ');

  return (
    <div className="py-2 px-4">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-start gap-2.5 px-3 py-2.5 rounded-lg bg-amber-500/10 border border-amber-500/20 hover:bg-amber-500/15 transition-colors text-left"
      >
        <Archive className="w-4 h-4 text-amber-400 mt-0.5 flex-shrink-0" />
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-medium text-amber-300">
            已压缩 {compaction.compactedMessageCount} 条消息，节省 {compaction.compactedTokenCount.toLocaleString()} tokens
          </span>
          {(source || providerModel || warnings.length > 0 || manifestCounts) && (
            <span className="mt-1 flex flex-wrap gap-1.5">
              {source && <CompactionMetaPill label="source" value={source} />}
              {providerModel && <CompactionMetaPill label="model" value={providerModel} />}
              {warnings.length > 0 && <CompactionMetaPill label="warnings" value={String(warnings.length)} />}
              {manifestCounts && <CompactionMetaPill label="survivors" value={manifestCounts} />}
            </span>
          )}
        </span>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-amber-400 mt-0.5 flex-shrink-0" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 px-3 py-2.5 rounded-md bg-amber-500/5 border border-amber-500/10">
          {(warnings.length > 0 || files.length > 0 || errors.length > 0 || openWork.length > 0) && (
            <div className="mb-2 grid gap-2 sm:grid-cols-2">
              <CompactionDetailList
                label="warnings"
                items={warnings}
                renderItem={(item) => ({ text: String(item) })}
              />
              <CompactionDetailList
                label="files"
                items={files}
                renderItem={(item) => {
                  if (typeof item === 'string') return { text: item };
                  if (isSurvivorFile(item)) return { text: compactPath(item.path), title: item.path };
                  return { text: compactItemText(item) };
                }}
              />
              <CompactionDetailList
                label="errors"
                items={errors}
                renderItem={(item) => {
                  if (typeof item === 'string') return { text: item };
                  if (isSurvivorFile(item)) return { text: compactPath(item.path), title: item.path };
                  return { text: compactItemText(item) };
                }}
              />
              <CompactionDetailList
                label="open work"
                items={openWork}
                renderItem={(item) => {
                  if (typeof item === 'string') return { text: item };
                  if (isSurvivorFile(item)) return { text: compactPath(item.path), title: item.path };
                  return { text: compactItemText(item) };
                }}
              />
            </div>
          )}
          <p className="text-xs text-zinc-400 leading-relaxed whitespace-pre-wrap">
            {compaction.content}
          </p>
        </div>
      )}
    </div>
  );
};

// Main MessageBubble component - routes to appropriate display
export const MessageBubble: React.FC<MessageBubbleProps> = ({ message }) => {
  const editMessage = useMessageActionStore((s) => s.editMessage);
  const regenerateMessage = useMessageActionStore((s) => s.regenerateMessage);
  const forkFromHere = useMessageActionStore((s) => s.forkFromHere);

  const handleEdit = useCallback(
    (messageId: string, newContent: string) => editMessage(messageId, newContent),
    [editMessage],
  );
  const handleRegenerate = useCallback(
    (messageId: string) => regenerateMessage(messageId),
    [regenerateMessage],
  );
  const handleForkFromHere = useCallback(
    (messageId: string) => forkFromHere(messageId),
    [forkFromHere],
  );

  // CompactionBlock: 渲染压缩摘要卡片
  if (message.compaction) {
    return <CompactionBlockDisplay message={message} />;
  }

  // Skill 系统：检测并渲染 Skill 状态消息
  if (message.source === 'skill' && isSkillStatusContent(message.content)) {
    return <SkillStatusMessage content={message.content} />;
  }

  // /goal 生命周期通知（开启目标 / 已完成 / 已中止）——在 system-null 之前拦截
  if (message.source === 'goal' && isGoalNoticeContent(message.content)) {
    return <GoalNoticeMessage content={message.content} />;
  }

  // System messages (nudges, recovery hints) are internal — never show to user
  if (message.role === 'system') {
    return null;
  }

  // Tool messages 的 content 是 JSON.stringify(toolResults[]) 字符串(OpenAI 协议要求 string),
  // 不能 fallthrough 到 AssistantMessage 当文本/markdown 渲染——会变成一坨 escaped JSON。
  // 工具结果已经通过 tool_call_end event 在 ToolCallDisplay 里结构化展示,这里隐藏即可。
  if (message.role === 'tool') {
    return null;
  }

  if (message.role === 'user') {
    return <UserMessage message={message} onEdit={handleEdit} />;
  }

  // All assistant messages use the same terminal-style display
  return <AssistantMessage message={message} onRegenerate={handleRegenerate} onForkFromHere={handleForkFromHere} />;
};

// Re-export sub-components for direct use if needed
export { UserMessage } from './UserMessage';
export { AssistantMessage } from './AssistantMessage';
export { SkillStatusMessage, isSkillStatusContent } from './SkillStatusMessage';
export { MessageContent, CodeBlock, InlineTextWithCode } from './MessageContent';
export { ToolCallDisplay } from './ToolCallDisplay/index';
export { AttachmentDisplay } from './AttachmentPreview';

// Re-export types
export type {
  MessageBubbleProps,
  UserMessageProps,
  AssistantMessageProps,
  MessageContentProps,
  ToolCallDisplayProps,
  AttachmentDisplayProps,
  CodeBlockProps,
} from './types';

// Re-export utilities
export { formatTime, formatFileSize, languageConfig, parseMarkdownBlocks } from './utils';
