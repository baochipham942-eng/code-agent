// ============================================================================
// Agents - Display active agents for current session
// ============================================================================

import React, { useEffect, useState } from 'react';
import { Bot, ChevronDown, ChevronRight, Users, Workflow, GitBranch } from 'lucide-react';
import { useSessionStore } from '../../stores/sessionStore';
import { useMultiAgentDetection, type CollaborationPattern } from '../../hooks/useMultiAgentDetection';
import { useI18n } from '../../hooks/useI18n';
import { EVALUATION_CHANNELS } from '@shared/ipc';
import type { TestReportListItem } from '@shared/ipc';

// Agent 角色颜色映射
const AGENT_COLORS: Record<string, string> = {
  main: 'text-blue-400',
  coder: 'text-emerald-400',
  reviewer: 'text-amber-400',
  explore: 'text-cyan-400',
  plan: 'text-purple-400',
  tester: 'text-orange-400',
  debugger: 'text-red-400',
  documenter: 'text-green-400',
  architect: 'text-indigo-400',
  default: 'text-zinc-400',
};

// Agent 角色图标
const AGENT_ICONS: Record<string, string> = {
  main: '🤖',
  coder: '💻',
  reviewer: '🔍',
  explore: '🔎',
  plan: '📋',
  tester: '🧪',
  debugger: '🐛',
  documenter: '📝',
  architect: '🏗️',
};

// 协作模式显示（排除 null）
type NonNullPattern = Exclude<CollaborationPattern, null>;
const PATTERN_INFO: Record<NonNullPattern, { icon: React.ReactNode; label: string; color: string }> = {
  single: { icon: <Bot className="w-3 h-3" />, label: '单 Agent', color: 'text-zinc-400' },
  sequential: { icon: <Workflow className="w-3 h-3" />, label: '顺序协作', color: 'text-blue-400' },
  parallel: { icon: <Users className="w-3 h-3" />, label: '并行协作', color: 'text-emerald-400' },
  hierarchical: { icon: <GitBranch className="w-3 h-3" />, label: '层级编排', color: 'text-purple-400' },
};

export const Agents: React.FC = () => {
  const { t } = useI18n();
  const { messages } = useSessionStore();
  const { isMultiAgent, agentCount, activeAgents, pattern } = useMultiAgentDetection(messages);
  const [expanded, setExpanded] = useState(true);

  // 获取 agent 颜色
  const getAgentColor = (agent: string) => {
    return AGENT_COLORS[agent.toLowerCase()] || AGENT_COLORS.default;
  };

  // 获取 agent 图标
  const getAgentIcon = (agent: string) => {
    return AGENT_ICONS[agent.toLowerCase()] || '🤖';
  };

  // 获取协作模式信息
  const patternInfo = pattern ? PATTERN_INFO[pattern] : PATTERN_INFO.single;

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center w-full"
      >
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <Bot className="w-4 h-4 text-blue-400 flex-shrink-0" />
          <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
            {t.taskPanel.agents}
          </span>
          {agentCount > 1 && (
            <span className="text-xs text-zinc-500">({agentCount})</span>
          )}
        </div>
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-zinc-500 flex-shrink-0" />
        )}
      </button>

      {expanded && (
        <div className="mt-3 space-y-2">
          {/* 协作模式 */}
          <div className={`flex items-center gap-2 text-xs ${patternInfo.color}`}>
            {patternInfo.icon}
            <span>{patternInfo.label}</span>
          </div>

          {/* 活跃 Agents 列表 */}
          <div className="space-y-1">
            {activeAgents.map((agent) => (
              <div
                key={agent}
                className="flex items-center gap-2 py-1 px-2 bg-zinc-800 rounded"
              >
                <span className="text-sm">{getAgentIcon(agent)}</span>
                <span className={`text-sm ${getAgentColor(agent)} truncate`}>
                  {agent}
                </span>
                {agent === 'main' && (
                  <span className="text-xs text-zinc-600 ml-auto">主</span>
                )}
              </div>
            ))}
          </div>

          {/* 多 Agent 提示 */}
          {isMultiAgent && (
            <div className="text-xs text-zinc-500 pt-1 border-t border-white/[0.04]">
              {agentCount} 个 Agent 协同工作中
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const EvalAgentsView: React.FC = () => {
  const [reports, setReports] = useState<TestReportListItem[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let mounted = true;

    const loadReports = async () => {
      setLoading(true);
      try {
        const result = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS);
        if (mounted) {
          setReports((result ?? []).slice(0, 5));
        }
      } catch {
        if (mounted) {
          setReports([]);
        }
      } finally {
        if (mounted) {
          setLoading(false);
        }
      }
    };

    loadReports();
    return () => {
      mounted = false;
    };
  }, []);

  const getPassRateColor = (passRate: number): string => {
    if (passRate >= 0.8) return 'text-emerald-400';
    if (passRate >= 0.6) return 'text-amber-400';
    return 'text-red-400';
  };

  return (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl p-3 border border-white/[0.04]">
      <div className="flex items-center gap-2 mb-3">
        <Bot className="w-4 h-4 text-blue-400 flex-shrink-0" />
        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">Eval Agents</span>
      </div>

      {loading ? (
        <div className="text-xs text-zinc-500">加载评测报告中...</div>
      ) : reports.length === 0 ? (
        <div className="text-xs text-zinc-500">暂无评测报告</div>
      ) : (
        <div className="space-y-2">
          {reports.map((report) => {
            const passRate = report.total > 0 ? report.passed / report.total : 0;
            return (
              <div
                key={report.filePath}
                className="flex items-center justify-between py-1.5 px-2 bg-zinc-800 rounded"
              >
                <div className="min-w-0">
                  <div className="text-xs text-zinc-400 truncate">{report.fileName}</div>
                  <div className="text-[11px] text-zinc-500">
                    Score {Math.round(report.averageScore)} · {report.passed}/{report.total}
                  </div>
                </div>
                <div className={`text-xs font-medium ${getPassRateColor(passRate)}`}>
                  {Math.round(passRate * 100)}%
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
