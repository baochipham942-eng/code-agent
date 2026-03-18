// ============================================================================
// TaskMonitor - QoderWork-style task monitoring panel
// ============================================================================
// 三个 Section：待办 | 产物 | 技能 & MCP
// 借鉴 QoderWork 的 TaskMonitor 设计（逆向验证）
// ============================================================================

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import { useAppStore } from '../../stores/appStore';
import { useSkillStore } from '../../stores/skillStore';
import {
  Check, ChevronDown, ChevronRight, ClipboardList,
  Loader2, Clock, AlertTriangle, Eye, Pencil, Terminal,
  Search, Plug, FileText, Sparkles, FolderOpen,
} from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import type { ToolProgressData, ToolTimeoutData, AgentEvent } from '@shared/types';
import ipcService from '../../services/ipcService';

// 工具分类（用于 phase-based 进度推导）
type PhaseType = 'read' | 'edit' | 'execute' | 'search' | 'mcp';

function classifyTool(name: string): PhaseType | null {
  const n = name.toLowerCase();
  if (n.startsWith('mcp__') || n.startsWith('mcp_')) return 'mcp';
  if (['read', 'glob', 'grep'].some(k => n.includes(k))) return 'read';
  if (['edit', 'write'].some(k => n.includes(k))) return 'edit';
  if (n === 'bash' || n.includes('notebook')) return 'execute';
  if (['search', 'fetch'].some(k => n.includes(k))) return 'search';
  return null;
}

const PHASE_ICONS: Record<PhaseType, React.FC<{ className?: string }>> = {
  read: Eye,
  edit: Pencil,
  execute: Terminal,
  search: Search,
  mcp: Plug,
};

function formatElapsed(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}m ${secs}s`;
}

interface ArtifactInfo {
  path: string;
  name: string;
}

export const TaskMonitor: React.FC = () => {
  const { todos, currentSessionId, messages } = useSessionStore();
  const { workingDirectory } = useAppStore();
  const sessionTaskProgress = useAppStore((state) => state.sessionTaskProgress);
  const { mountedSkills, setCurrentSession } = useSkillStore();
  const { t } = useI18n();

  const [isExpanded, setIsExpanded] = useState(true);
  const [toolProgress, setToolProgress] = useState<ToolProgressData | null>(null);
  const [toolTimeout, setToolTimeout] = useState<ToolTimeoutData | null>(null);
  const taskProgress = currentSessionId ? sessionTaskProgress[currentSessionId] ?? null : null;

  // 同步 skill store 的 session
  useEffect(() => {
    if (currentSessionId) setCurrentSession(currentSessionId);
  }, [currentSessionId, setCurrentSession]);

  // 订阅工具进度事件
  const handleAgentEvent = useCallback((event: AgentEvent & { sessionId?: string }) => {
    if (event.sessionId && currentSessionId && event.sessionId !== currentSessionId) return;
    switch (event.type) {
      case 'tool_progress':
        if (event.data) setToolProgress(event.data as ToolProgressData);
        break;
      case 'tool_timeout':
        if (event.data) setToolTimeout(event.data as ToolTimeoutData);
        break;
      case 'tool_call_end':
        if (event.data) {
          const toolCallId = (event.data as { toolCallId?: string }).toolCallId;
          setToolProgress((prev) => prev?.toolCallId === toolCallId ? null : prev);
          setToolTimeout((prev) => prev?.toolCallId === toolCallId ? null : prev);
        }
        break;
      case 'agent_complete':
        setToolProgress(null);
        setToolTimeout(null);
        break;
    }
  }, [currentSessionId]);

  useEffect(() => {
    setToolProgress(null);
    setToolTimeout(null);
  }, [currentSessionId]);

  useEffect(() => {
    const unsubscribe = ipcService.on('agent:event' as any, handleAgentEvent);
    return () => { unsubscribe?.(); };
  }, [handleAgentEvent]);

  // ── 数据计算 ──

  const completedCount = todos.filter((item) => item.status === 'completed').length;
  const totalCount = todos.length;

  // Phase-based 进度推导（无 todos 时的回退方案）
  const toolPhases = useMemo(() => {
    if (totalCount > 0) return [];
    const phases: Array<{ type: PhaseType; count: number; status: 'completed' | 'in_progress' }> = [];
    for (const msg of messages.slice(-30)) {
      if (!msg.toolCalls) continue;
      for (const tc of msg.toolCalls) {
        const phase = classifyTool(tc.name);
        if (!phase) continue;
        const last = phases[phases.length - 1];
        if (last && last.type === phase) {
          last.count++;
        } else {
          if (phases.length > 0) phases[phases.length - 1].status = 'completed';
          phases.push({ type: phase, count: 1, status: 'in_progress' });
        }
      }
    }
    return phases;
  }, [messages, totalCount]);

  // 产物：从 Write/Edit 工具调用中提取
  const artifacts = useMemo(() => {
    const files: ArtifactInfo[] = [];
    const seenPaths = new Set<string>();
    for (const message of messages.slice(-20).reverse()) {
      if (!message.toolCalls) continue;
      for (const toolCall of message.toolCalls) {
        if (['Write', 'Edit'].includes(toolCall.name)) {
          const args = toolCall.arguments as Record<string, unknown>;
          const filePath = (args?.path || args?.file_path) as string | undefined;
          if (filePath && !seenPaths.has(filePath)) {
            seenPaths.add(filePath);
            files.push({ path: filePath, name: filePath.split('/').pop() || filePath });
            if (files.length >= 8) break;
          }
        }
      }
      if (files.length >= 8) break;
    }
    return files;
  }, [messages]);

  const folderName = workingDirectory ? workingDirectory.split('/').pop() || workingDirectory : null;
  const showToolElapsed = toolProgress && toolProgress.elapsedMs >= 5000;
  const isAgentWorking = taskProgress && taskProgress.phase !== 'completed';

  const phaseLabel = (type: PhaseType): string => {
    const map: Record<PhaseType, string> = {
      read: t.taskPanel.phaseRead,
      edit: t.taskPanel.phaseEdit,
      execute: t.taskPanel.phaseExecute,
      search: t.taskPanel.phaseSearch,
      mcp: t.taskPanel.phaseMcp,
    };
    return map[type];
  };

  // ── 渲染 ──

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04]">
      {/* Header */}
      <button
        onClick={() => setIsExpanded(!isExpanded)}
        className="flex items-center w-full p-3"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <ClipboardList className="w-4 h-4 text-emerald-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.monitorTitle}
          </span>
          {totalCount > 0 && (
            <span className="text-xs text-zinc-500">{completedCount}/{totalCount}</span>
          )}
        </div>
        {isExpanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {isExpanded && (
        <div className="px-3 pb-3 space-y-3">
          {/* 工作目录（一行） */}
          {folderName && (
            <div className="flex items-center gap-1.5 text-xs text-zinc-500">
              <FolderOpen className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">
                {t.taskPanel.workIn.replace('{folderName}', folderName)}
              </span>
            </div>
          )}

          {/* 实时进度指示器 */}
          {isAgentWorking && (
            <div className="flex items-center gap-2 py-1 px-2 bg-primary-500/5 rounded-lg">
              <Loader2 className="w-3.5 h-3.5 text-primary-500 animate-spin flex-shrink-0" />
              <span className="text-xs text-zinc-300 flex-1 truncate">
                {taskProgress.step || taskProgress.phase}
              </span>
              {showToolElapsed && (
                <span className={`flex items-center gap-1 text-xs shrink-0 ${
                  toolTimeout ? 'text-amber-400' : 'text-zinc-500'
                }`}>
                  <Clock className="w-3 h-3" />
                  {formatElapsed(toolProgress!.elapsedMs)}
                </span>
              )}
            </div>
          )}

          {/* 超时警告 */}
          {toolTimeout && (
            <div className="flex items-center gap-2 text-xs text-amber-400/80 py-1">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              <span>{toolTimeout.toolName} {formatElapsed(toolTimeout.elapsedMs)}</span>
            </div>
          )}

          {/* Section 1: 待办 */}
          <Section title={t.taskPanel.sectionTodos}>
            {totalCount > 0 ? (
              <div className="space-y-0.5">
                {todos.map((todo, index) => (
                  <div key={index} className="flex items-center gap-2 py-0.5">
                    {todo.status === 'completed' ? (
                      <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                        <Check className="w-2.5 h-2.5 text-white" />
                      </div>
                    ) : todo.status === 'in_progress' ? (
                      <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                        <Loader2 className="w-2.5 h-2.5 text-primary-400 animate-spin" />
                      </div>
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-zinc-600 flex-shrink-0" />
                    )}
                    <span className={`text-xs truncate ${
                      todo.status === 'completed' ? 'text-zinc-500 line-through'
                        : todo.status === 'in_progress' ? 'text-zinc-200'
                        : 'text-zinc-400'
                    }`}>
                      {todo.status === 'in_progress' ? todo.activeForm : todo.content}
                    </span>
                  </div>
                ))}
              </div>
            ) : toolPhases.length > 0 ? (
              <div className="space-y-0.5">
                {toolPhases.map((phase, index) => {
                  const PhaseIcon = PHASE_ICONS[phase.type];
                  return (
                    <div key={`${phase.type}-${index}`} className="flex items-center gap-2 py-0.5">
                      {phase.status === 'completed' ? (
                        <div className="w-4 h-4 rounded-full bg-primary-500 flex items-center justify-center flex-shrink-0">
                          <Check className="w-2.5 h-2.5 text-white" />
                        </div>
                      ) : (
                        <div className="w-4 h-4 rounded-full bg-primary-500/20 flex items-center justify-center flex-shrink-0 animate-pulse">
                          <PhaseIcon className="w-2.5 h-2.5 text-primary-400" />
                        </div>
                      )}
                      <span className={`text-xs flex-1 ${
                        phase.status === 'completed' ? 'text-zinc-500' : 'text-zinc-200'
                      }`}>
                        {phaseLabel(phase.type)}
                      </span>
                      <span className="text-xs text-zinc-600">
                        {t.taskPanel.phaseOps.replace('{count}', String(phase.count))}
                      </span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState text={t.taskPanel.todosEmpty} />
            )}
          </Section>

          {/* Section 2: 产物 */}
          <Section title={t.taskPanel.sectionArtifacts}>
            {artifacts.length > 0 ? (
              <div className="space-y-0.5">
                {artifacts.map((file) => (
                  <div key={file.path} className="flex items-center gap-2 py-0.5" title={file.path}>
                    <FileText className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
                    <span className="text-xs text-zinc-400 truncate font-mono">{file.name}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text={t.taskPanel.artifactsEmpty} />
            )}
          </Section>

          {/* Section 3: 技能 & MCP */}
          <Section title={t.taskPanel.sectionSkillsMcp}>
            {mountedSkills.length > 0 ? (
              <div className="space-y-0.5">
                {mountedSkills.map((mount) => (
                  <div key={mount.skillName} className="flex items-center gap-2 py-0.5">
                    <Sparkles className="w-3 h-3 text-purple-400/70 flex-shrink-0" />
                    <span className="text-xs text-zinc-400 truncate">{mount.skillName}</span>
                  </div>
                ))}
              </div>
            ) : (
              <EmptyState text={t.taskPanel.skillsMcpEmpty} />
            )}
          </Section>
        </div>
      )}
    </div>
  );
};

/** Section 分隔组件 */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="pt-2 border-t border-white/[0.04] first:pt-0 first:border-t-0">
      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1.5">
        {title}
      </div>
      {children}
    </div>
  );
}

/** 空状态 */
function EmptyState({ text }: { text: string }) {
  return <div className="text-xs text-zinc-600 py-1">{text}</div>;
}
