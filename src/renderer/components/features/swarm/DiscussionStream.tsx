// ============================================================================
// DiscussionStream - 多 agent 协作「讨论流」（P1-3 协作过程可见性）
// ============================================================================
// 把 agent 间消息 + SharedContext 发现/决策/人话状态渲染成时间线对话流，
// 让 cowork 非程序员用户看懂「agent 们在怎么讨论」，而非只看任务进度条。
//
// 数据源：swarmStore.eventLog（buildTimelineEntry 已把各类 swarm 事件归一成
// 人话 title/summary/tone；context:update 携带 contextKind / highlight）。
// 折叠态默认展示最近 previewCount 条（运行时一直可见），展开看全量时间线。
// ============================================================================

import React, { useState } from 'react';
import {
  MessagesSquare,
  Lightbulb,
  GitBranch,
  Send,
  UserCog,
  Activity,
  CheckCircle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useSwarmStore, type SwarmTimelineEvent } from '../../../stores/swarmStore';

// 相对时间：刚刚 / X 秒前 / X 分钟前 / X 小时前 / X 天前（数据新鲜度，依赖 #213 版本戳）
export const formatRelativeTime = (ts: number, now: number = Date.now()): string => {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 10) return '刚刚';
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  return `${Math.floor(hr / 24)} 天前`;
};

// 条目图标：优先按 SharedContext 变更类型，回落到事件类型
const DiscussionIcon: React.FC<{ entry: SwarmTimelineEvent }> = ({ entry }) => {
  const cls = 'w-3 h-3 shrink-0';
  switch (entry.contextKind) {
    case 'finding':
      return <Lightbulb className={`${cls} text-amber-400`} />;
    case 'decision':
      return <GitBranch className={`${cls} text-violet-400`} />;
    case 'result':
      return <CheckCircle className={`${cls} text-emerald-400`} />;
    case 'status':
      return <Activity className={`${cls} text-cyan-400`} />;
    default:
      break;
  }
  if (entry.type === 'swarm:user:message') return <UserCog className={`${cls} text-cyan-400`} />;
  if (entry.type === 'swarm:agent:message') return <Send className={`${cls} text-blue-400`} />;
  return <MessagesSquare className={`${cls} text-zinc-400`} />;
};

const discussionToneText: Record<SwarmTimelineEvent['tone'], string> = {
  neutral: 'text-zinc-300',
  success: 'text-emerald-300',
  warning: 'text-amber-300',
  error: 'text-red-300',
};

const DiscussionEntry: React.FC<{ entry: SwarmTimelineEvent }> = ({ entry }) => (
  <div
    data-testid="discussion-entry"
    data-context-kind={entry.contextKind ?? ''}
    data-highlight={entry.highlight ? 'true' : 'false'}
    className={`mx-2 my-1 rounded-md border px-2 py-1 ${
      entry.highlight
        ? 'border-violet-500/40 bg-violet-500/10 ring-1 ring-violet-500/20'
        : 'border-zinc-700/50 bg-zinc-800/40'
    }`}
  >
    <div className="flex items-center gap-1.5">
      <DiscussionIcon entry={entry} />
      <span className={`text-[11px] font-medium truncate flex-1 ${discussionToneText[entry.tone]}`}>
        {entry.title}
      </span>
      {entry.highlight && (
        <span className="text-[9px] px-1 py-0.5 rounded bg-violet-500/20 text-violet-300 font-semibold whitespace-nowrap">
          决策点
        </span>
      )}
      <span className="text-[10px] text-zinc-600 whitespace-nowrap">
        {formatRelativeTime(entry.timestamp)}
      </span>
    </div>
    {entry.summary && (
      <div className="mt-0.5 pl-[18px] text-[10px] text-zinc-400 line-clamp-2 whitespace-pre-wrap break-words">
        {entry.summary}
      </div>
    )}
  </div>
);

interface DiscussionStreamProps {
  /** 折叠态预览的条数（默认 3，让讨论流运行时一直可见） */
  previewCount?: number;
}

export function DiscussionStream({ previewCount = 3 }: DiscussionStreamProps) {
  const eventLog = useSwarmStore((s) => s.eventLog ?? []);
  const [expanded, setExpanded] = useState(false);

  if (eventLog.length === 0) return null;

  // eventLog 已按时间正序累积；折叠态取最近 previewCount 条
  const visible = expanded ? eventLog : eventLog.slice(-previewCount);

  return (
    <div className="border-t border-zinc-700/40" data-testid="discussion-stream">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center gap-1.5 px-3 py-1.5 hover:bg-zinc-800/40 transition-colors"
        title={expanded ? '折叠讨论流' : '展开完整讨论流'}
      >
        <MessagesSquare size={12} className="text-cyan-400" />
        <span className="text-[11px] text-zinc-400">讨论流</span>
        <span className="text-[10px] text-zinc-600">({eventLog.length})</span>
        <span className="ml-auto text-zinc-500">
          {expanded ? <ChevronDown size={12} /> : <ChevronUp size={12} />}
        </span>
      </button>
      <div className={expanded ? 'max-h-56 overflow-y-auto pb-1' : 'pb-1'}>
        {visible.map((entry) => (
          <DiscussionEntry key={entry.id} entry={entry} />
        ))}
      </div>
    </div>
  );
}

export default DiscussionStream;
