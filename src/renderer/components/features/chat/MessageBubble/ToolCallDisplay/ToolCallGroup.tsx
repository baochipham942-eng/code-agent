// ============================================================================
// ToolCallGroup - 自动分组折叠多个工具调用
// 3+ 个工具调用自动归组，全部完成后折叠为摘要行
// ============================================================================

import React, { useState, useMemo, useEffect, useRef } from 'react';
import type { ToolCall } from '@shared/types';
import { useAppStore } from '../../../../../stores/appStore';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { ToolCallDisplay } from './index';
import { getToolStatus, getStatusColor, type ToolStatus } from './styles';
import { getToolDisplayName, formatDuration } from './utils';
import { UI } from '@shared/constants';

// Braille spinner for group pending state
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

interface ToolCallGroupProps {
  toolCalls: ToolCall[];
  startIndex: number;
}

type GroupStatus = 'pending' | 'success' | 'error';

export function ToolCallGroup({ toolCalls, startIndex }: ToolCallGroupProps) {
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const processingSessionIds = useAppStore((state) => state.processingSessionIds);

  // 计算每个工具的状态
  const statuses = useMemo(
    () =>
      toolCalls.map((tc) =>
        getToolStatus(tc, currentSessionId, processingSessionIds)
      ),
    [toolCalls, currentSessionId, processingSessionIds]
  );

  // 聚合状态
  const groupStatus: GroupStatus = useMemo(() => {
    if (statuses.some((s) => s === 'error')) return 'error';
    if (statuses.some((s) => s === 'pending')) return 'pending';
    return 'success';
  }, [statuses]);

  // 折叠状态
  const [collapsed, setCollapsed] = useState(false);
  const [userToggled, setUserToggled] = useState(false);

  // 自动折叠：全部成功后延迟折叠（除非用户手动操作过）
  useEffect(() => {
    if (groupStatus === 'success' && !collapsed && !userToggled) {
      const timer = setTimeout(
        () => setCollapsed(true),
        UI.TOOL_GROUP_COLLAPSE_DELAY
      );
      return () => clearTimeout(timer);
    }
  }, [groupStatus, collapsed, userToggled]);

  // 有错误时保持展开
  useEffect(() => {
    if (groupStatus === 'error') {
      setCollapsed(false);
      setUserToggled(false);
    }
  }, [groupStatus]);

  // 构建摘要文本: "Edit ×2, Read, Bash"
  const summaryText = useMemo(() => {
    const counts = new Map<string, number>();
    for (const tc of toolCalls) {
      const name = getToolDisplayName(tc.name);
      counts.set(name, (counts.get(name) || 0) + 1);
    }
    return Array.from(counts.entries())
      .map(([name, count]) => (count > 1 ? `${name} ×${count}` : name))
      .join(', ');
  }, [toolCalls]);

  // 计算总耗时
  const totalDuration = useMemo(() => {
    let total = 0;
    for (const tc of toolCalls) {
      if (tc.result?.duration) {
        total += tc.result.duration;
      }
    }
    return total > 0 ? formatDuration(total) : null;
  }, [toolCalls]);

  // Spinner for pending
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (groupStatus === 'pending') {
      const interval = setInterval(() => {
        setFrame((f) => (f + 1) % BRAILLE_FRAMES.length);
      }, 80);
      return () => clearInterval(interval);
    }
  }, [groupStatus]);

  const statusColor = getStatusColor(groupStatus === 'error' ? 'error' : groupStatus === 'pending' ? 'pending' : 'success');

  // 状态指示符
  const statusIndicator = useMemo(() => {
    switch (groupStatus) {
      case 'pending':
        return BRAILLE_FRAMES[frame];
      case 'success':
        return '●';
      case 'error':
        return '✗';
    }
  }, [groupStatus, frame]);

  if (!collapsed) {
    // 展开视图：正常渲染各 ToolCallDisplay + 可点击的组头
    return (
      <div>
        {/* 可折叠的组标题 */}
        <div
          className="flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800/50 rounded px-1 py-0.5 transition-colors font-mono text-sm mb-0.5"
          onClick={() => {
            setCollapsed(true);
            setUserToggled(true);
          }}
        >
          <span className={`w-4 flex-shrink-0 text-center ${statusColor.dot}`}>
            {statusIndicator}
          </span>
          <span className="text-zinc-500 text-xs">
            {toolCalls.length} tool calls
          </span>
          <span className="text-zinc-600 text-xs ml-1">▼</span>
        </div>

        {/* 逐个渲染 */}
        {toolCalls.map((toolCall, index) => (
          <ToolCallDisplay
            key={toolCall.id}
            toolCall={toolCall}
            index={startIndex + index}
            total={startIndex + toolCalls.length}
          />
        ))}
      </div>
    );
  }

  // 折叠视图：摘要行
  return (
    <div
      className="flex items-center gap-1.5 cursor-pointer hover:bg-zinc-800/50 rounded px-1 py-0.5 transition-colors font-mono text-sm"
      onClick={() => {
        setCollapsed(false);
        setUserToggled(true);
      }}
    >
      <span className={`w-4 flex-shrink-0 text-center ${statusColor.dot}`}>
        {statusIndicator}
      </span>
      <span className="text-zinc-300 font-bold">
        {toolCalls.length} tool calls
      </span>
      <span className="text-zinc-500 text-xs">
        ({summaryText})
      </span>
      {totalDuration && (
        <span className="text-zinc-600 text-xs ml-auto">
          {totalDuration}
        </span>
      )}
      <span className="text-zinc-600 text-xs ml-1">▶</span>
    </div>
  );
}
