import React, { useState, useEffect } from 'react';
import { TestResultsDashboard } from '../testResults/TestResultsDashboard';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';
import type { TestRunReport, TestCaseResult } from '@shared/ipc';
import { CaseDetailPage } from './CaseDetailPage';
import ipcService from '../../../../services/ipcService';

type DetailTab = 'overview' | 'cases' | 'trace' | 'scoring' | 'ai-analysis';

const TABS: Array<{ key: DetailTab; label: string; icon: string }> = [
  { key: 'overview', label: '结果概览', icon: '\u{1F4CA}' },
  { key: 'cases', label: 'Case 列表', icon: '\u{1F4CB}' },
  { key: 'trace', label: 'Agent 轨迹', icon: '\u{1F50D}' },
  { key: 'scoring', label: '评分详情', icon: '\u{1F3AF}' },
  { key: 'ai-analysis', label: 'AI 分析', icon: '\u{1F9EA}' },
];

const STATUS_STYLES: Record<string, { color: string; bg: string; label: string }> = {
  passed: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: '通过' },
  failed: { color: 'text-red-400', bg: 'bg-red-500/10', label: '失败' },
  partial: { color: 'text-amber-400', bg: 'bg-amber-500/10', label: '部分通过' },
  skipped: { color: 'text-zinc-400', bg: 'bg-zinc-600/10', label: '跳过' },
};

interface ExperimentData {
  id: string;
  name: string;
  model: string;
  status: string;
  created_at: number;
  cases: ExperimentCase[];
}

interface ExperimentCase {
  id: string;
  case_id: string;
  status: string;
  score: number;
  duration_ms: number;
  data_json: string;
}

export const ExperimentDetailPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [report, setReport] = useState<TestRunReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedCase, setSelectedCase] = useState<TestCaseResult | null>(null);

  // DB-based experiment data
  const [experiment, setExperiment] = useState<ExperimentData | null>(null);
  const [experimentLoading, setExperimentLoading] = useState(true);

  // Case detail navigation
  const [selectedCaseForDetail, setSelectedCaseForDetail] = useState<{ experimentId: string; caseId: string } | null>(null);

  // Load experiment from DB
  useEffect(() => {
    const loadExperiment = async () => {
      setExperimentLoading(true);
      try {
        const experiments = await ipcService.invoke(
          EVALUATION_CHANNELS.LIST_EXPERIMENTS as 'evaluation:list-experiments',
          10
        ) as Array<{ id: string }> | undefined;
        if (experiments && experiments.length > 0) {
          const latest = experiments[0];
          const data = await ipcService.invoke(
            EVALUATION_CHANNELS.LOAD_EXPERIMENT as 'evaluation:load-experiment',
            latest.id
          ) as ExperimentData | null | undefined;
          if (data) {
            setExperiment(data);
          }
        }
      } catch { /* best-effort */ }
      finally { setExperimentLoading(false); }
    };
    loadExperiment();
  }, []);

  // Also load file-based report as fallback
  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const list = await ipcService.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as { filePath: string }[] | undefined;
        if (list && list.length > 0) {
          const data = await ipcService.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, list[0].filePath) as TestRunReport | null | undefined;
          if (data) setReport(data);
        }
      } catch { /* best-effort */ }
      finally { setLoading(false); }
    };
    load();
  }, []);

  // If navigating to CaseDetail, render it instead
  if (selectedCaseForDetail) {
    return (
      <CaseDetailPage
        experimentId={selectedCaseForDetail.experimentId}
        caseId={selectedCaseForDetail.caseId}
        onBack={() => setSelectedCaseForDetail(null)}
      />
    );
  }

  const hasData = report && report.results && report.results.length > 0;
  const hasExperimentCases = experiment && experiment.cases && experiment.cases.length > 0;
  const passRate = report ? Math.round((report.passed / Math.max(report.total, 1)) * 100) : 0;

  const STAT_CARDS = [
    {
      label: '用例总数',
      value: report?.total ?? 0,
      suffix: '',
      border: 'border-l-blue-500',
      iconColor: 'text-blue-400',
      iconBg: 'bg-blue-500/10',
    },
    {
      label: '通过',
      value: report?.passed ?? 0,
      suffix: '',
      border: 'border-l-emerald-500',
      iconColor: 'text-emerald-400',
      iconBg: 'bg-emerald-500/10',
    },
    {
      label: '失败',
      value: report?.failed ?? 0,
      suffix: '',
      border: 'border-l-red-500',
      iconColor: 'text-red-400',
      iconBg: 'bg-red-500/10',
    },
    {
      label: '通过率',
      value: passRate,
      suffix: '%',
      border: 'border-l-amber-500',
      iconColor: 'text-amber-400',
      iconBg: 'bg-amber-500/10',
    },
  ];

  const isLoading = loading || experimentLoading;

  const EmptyGuide = ({ message }: { message: string }) => (
    <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
      <div className="w-14 h-14 rounded-2xl bg-zinc-700/60 border border-white/[0.04] flex items-center justify-center text-2xl">
        {'\u{1F9EA}'}
      </div>
      <p className="text-sm text-zinc-400">{message}</p>
      <p className="text-xs text-zinc-600 max-w-sm text-center">
        运行评测后，实验数据将出现在此。可在「会话评测」页面选择会话并执行评测。
      </p>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Git Commit Badge */}
      {!isLoading && hasData && report?.gitCommit && (
        <div className="flex items-center gap-2 px-4 pt-3">
          <span className="text-[10px] text-zinc-500">Git Commit:</span>
          <code className="text-[11px] font-mono text-zinc-400 bg-zinc-700/60 px-1.5 py-0.5 rounded border border-zinc-800">
            {report.gitCommit.length > 7 ? report.gitCommit.slice(0, 7) : report.gitCommit}
          </code>
        </div>
      )}

      {/* Experiment Name Badge */}
      {!isLoading && experiment && (
        <div className="flex items-center gap-2 px-4 pt-2">
          <span className="text-[10px] text-zinc-500">实验:</span>
          <span className="text-[11px] text-zinc-300">{experiment.name}</span>
          <span className="text-[10px] text-zinc-600 font-mono">{experiment.id.slice(0, 8)}</span>
        </div>
      )}

      {/* Stats Cards Header */}
      {!isLoading && hasData && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 px-4 pt-4">
          {STAT_CARDS.map(card => (
            <div
              key={card.label}
              className={`bg-zinc-800 rounded-lg border border-zinc-800 border-l-4 ${card.border} p-4 shadow-sm`}
            >
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-2xl font-bold text-zinc-200 tabular-nums">
                    {card.value}{card.suffix}
                  </div>
                  <div className="text-xs text-zinc-500 mt-1">{card.label}</div>
                </div>
                <div className={`w-10 h-10 rounded-lg ${card.iconBg} flex items-center justify-center`}>
                  <span className={`text-lg font-bold ${card.iconColor}`}>
                    {card.label === '用例总数' ? '\u{1F4CB}' : card.label === '通过' ? '\u2713' : card.label === '失败' ? '\u2717' : '%'}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-1 px-4 pt-3 border-b border-zinc-800">
        {TABS.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-3 py-2 text-xs transition border-b-2 flex items-center gap-1.5 ${
              activeTab === tab.key
                ? 'text-zinc-200 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-400 border-transparent'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      {isLoading && (
        <div className="flex-1 flex items-center justify-center">
          <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
      )}

      {!isLoading && (
        <div className="flex-1 overflow-y-auto">
          {activeTab === 'overview' && <TestResultsDashboard />}

          {activeTab === 'cases' && (
            <div className="p-4 space-y-3">
              {/* DB-based experiment cases */}
              {hasExperimentCases && (
                <>
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-xs text-zinc-500">DB 实验 Case ({experiment!.cases.length})</span>
                  </div>
                  <div className="bg-zinc-800 rounded-lg border border-zinc-800 overflow-hidden mb-4">
                    <div className="grid grid-cols-[1fr_80px_80px_80px_60px] gap-2 px-3 py-2 text-[10px] text-zinc-500 uppercase bg-zinc-900/30 border-b border-zinc-800">
                      <span>Case ID</span>
                      <span>状态</span>
                      <span>得分</span>
                      <span>耗时</span>
                      <span>操作</span>
                    </div>
                    {experiment!.cases.map(ec => {
                      const st = STATUS_STYLES[ec.status] || STATUS_STYLES.failed;
                      return (
                        <div
                          key={ec.id}
                          className="grid grid-cols-[1fr_80px_80px_80px_60px] gap-2 px-3 py-2 text-[11px] border-t border-zinc-700/10 hover:bg-zinc-800 transition"
                        >
                          <span className="text-zinc-400 font-mono truncate">{ec.case_id}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full w-fit ${st.bg} ${st.color}`}>
                            {st.label}
                          </span>
                          <span className={`font-mono ${ec.score >= 80 ? 'text-emerald-400' : ec.score >= 60 ? 'text-amber-400' : 'text-red-400'}`}>
                            {Math.round(ec.score)}
                          </span>
                          <span className="text-zinc-500">
                            {ec.duration_ms >= 1000 ? `${(ec.duration_ms / 1000).toFixed(1)}s` : `${ec.duration_ms}ms`}
                          </span>
                          <button
                            onClick={() => setSelectedCaseForDetail({ experimentId: experiment!.id, caseId: ec.case_id })}
                            className="text-[10px] text-blue-400 hover:text-blue-300 transition"
                          >
                            详情
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}

              {/* File-based report cases (fallback) */}
              {!hasExperimentCases && !hasData && (
                <EmptyGuide message="暂无 Case 评测数据" />
              )}
              {!hasExperimentCases && hasData && (
                <>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-zinc-500">共 {report!.results.length} 个 Case</span>
                    {Object.entries(STATUS_STYLES).map(([status, style]) => {
                      const count = report!.results.filter(r => r.status === status).length;
                      if (count === 0) return null;
                      return (
                        <span key={status} className={`text-[10px] px-2 py-0.5 rounded-full ${style.bg} ${style.color}`}>
                          {style.label}: {count}
                        </span>
                      );
                    })}
                  </div>

                  <div className="bg-zinc-800 rounded-lg border border-zinc-800 overflow-hidden">
                    <div className="grid grid-cols-[1fr_80px_80px_80px] gap-2 px-3 py-2 text-[10px] text-zinc-500 uppercase bg-zinc-900/30 border-b border-zinc-800">
                      <span>Test ID</span>
                      <span>状态</span>
                      <span>得分</span>
                      <span>耗时</span>
                    </div>
                    {report!.results.map(tc => {
                      const st = STATUS_STYLES[tc.status] || STATUS_STYLES.failed;
                      return (
                        <button
                          key={tc.testId}
                          onClick={() => setSelectedCase(selectedCase?.testId === tc.testId ? null : tc)}
                          className="w-full grid grid-cols-[1fr_80px_80px_80px] gap-2 px-3 py-2 text-[11px] border-t border-zinc-700/10 hover:bg-zinc-800 transition text-left"
                        >
                          <span className="text-zinc-400 font-mono truncate">{tc.testId}</span>
                          <span className={`text-[10px] px-1.5 py-0.5 rounded-full w-fit ${st.bg} ${st.color}`}>
                            {st.label}
                          </span>
                          <span className={`font-mono ${tc.score * 100 >= 80 ? 'text-emerald-400' : tc.score * 100 >= 60 ? 'text-amber-400' : 'text-red-400'}`}>{Math.round(tc.score * 100)}%</span>
                          <span className="text-zinc-500">{(tc.duration / 1000).toFixed(1)}s</span>
                        </button>
                      );
                    })}
                  </div>

                  {selectedCase && (
                    <div className="bg-zinc-800 rounded-lg border border-zinc-800 p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <h4 className="text-xs font-medium text-zinc-200">{selectedCase.testId}</h4>
                        <button onClick={() => setSelectedCase(null)} className="text-zinc-500 hover:text-zinc-400 text-xs">关闭</button>
                      </div>
                      <p className="text-xs text-zinc-400">{selectedCase.description}</p>
                      {selectedCase.errors.length > 0 && (
                        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                          {selectedCase.errors.map((err, i) => (
                            <p key={i} className="text-xs text-red-400 font-mono whitespace-pre-wrap">{err}</p>
                          ))}
                        </div>
                      )}
                      {selectedCase.failureReason && (
                        <div className="bg-amber-500/10 border border-amber-500/20 rounded-lg px-3 py-2">
                          <p className="text-xs text-amber-400">{selectedCase.failureReason}</p>
                        </div>
                      )}
                      {selectedCase.toolExecutions.length > 0 && (
                        <div>
                          <p className="text-[10px] text-zinc-500 uppercase mb-1.5">工具调用 ({selectedCase.toolExecutions.length})</p>
                          <div className="flex gap-1 flex-wrap">
                            {selectedCase.toolExecutions.map((tool, i) => (
                              <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded ${
                                tool.success ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                              }`}>
                                {tool.tool}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="flex gap-3 text-[10px] text-zinc-500">
                        <span>{selectedCase.turnCount} 轮</span>
                        <span>{(selectedCase.duration / 1000).toFixed(1)}s</span>
                        <span>得分: {Math.round(selectedCase.score * 100)}%</span>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {activeTab === 'trace' && (
            <div className="p-4">
              {!hasData ? (
                <EmptyGuide message="暂无 Agent 轨迹数据" />
              ) : (
                <div className="space-y-1">
                  <div className="flex items-center gap-3 mb-3">
                    <h4 className="text-xs font-medium text-zinc-400">Agent 执行时间线</h4>
                    <span className="text-[10px] text-zinc-500">共 {report!.results.length} 个 Case</span>
                  </div>

                  {report!.results.map((tc, idx) => {
                    const st = STATUS_STYLES[tc.status] || STATUS_STYLES.failed;
                    const failedTools = tc.toolExecutions.filter(t => !t.success).length;
                    const hasDeviation = failedTools > 0 || tc.status === 'failed';
                    return (
                      <div key={tc.testId} className="flex gap-3">
                        {/* Timeline spine */}
                        <div className="flex flex-col items-center w-5 shrink-0">
                          <div className={`w-2.5 h-2.5 rounded-full border-2 mt-3 ${
                            tc.status === 'passed' ? 'border-emerald-400 bg-emerald-400/30' :
                            tc.status === 'failed' ? 'border-red-400 bg-red-400/30' :
                            'border-amber-400 bg-amber-400/30'
                          }`} />
                          {idx < report!.results.length - 1 && (
                            <div className="w-px flex-1 bg-zinc-700 my-1" />
                          )}
                        </div>

                        {/* Case card */}
                        <div className="flex-1 bg-zinc-800 rounded-lg border border-zinc-800 p-3 mb-2">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs text-zinc-200 font-mono">{tc.testId}</span>
                            <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${st.bg} ${st.color}`}>
                              {st.label}
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              {tc.toolExecutions.length} 次调用
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              {(tc.duration / 1000).toFixed(1)}s
                            </span>
                            <span className="text-[10px] text-zinc-500">
                              {tc.turnCount} 轮
                            </span>
                            {hasDeviation && (
                              <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-500/10 text-amber-400">
                                {failedTools > 0 ? `${failedTools} 次工具失败` : '异常'}
                              </span>
                            )}
                          </div>

                          {/* Tool call sequence */}
                          {tc.toolExecutions.length > 0 && (
                            <div className="flex gap-0.5 flex-wrap mt-2">
                              {tc.toolExecutions.map((tool, i) => (
                                <React.Fragment key={i}>
                                  <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                                    tool.success ? 'bg-zinc-700 text-zinc-400' : 'bg-red-500/10 text-red-400'
                                  }`}>
                                    {tool.tool}
                                  </span>
                                  {i < tc.toolExecutions.length - 1 && (
                                    <span className="text-zinc-600 text-[8px] self-center">{String.fromCharCode(8594)}</span>
                                  )}
                                </React.Fragment>
                              ))}
                            </div>
                          )}

                          {tc.failureReason && (
                            <p className="text-[10px] text-red-400/70 mt-1.5 line-clamp-2">{tc.failureReason}</p>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {activeTab === 'scoring' && (
            <div className="p-4">
              {!hasData ? (
                <EmptyGuide message="暂无评分数据" />
              ) : (
                <div className="space-y-4">
                  <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4">
                    <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide mb-3">实验总览</h4>
                    <div className="flex items-center gap-4">
                      <div className={`text-4xl font-bold tabular-nums ${
                        passRate >= 80 ? 'text-emerald-400' : passRate >= 60 ? 'text-amber-400' : 'text-red-400'
                      }`}>
                        {passRate}%
                      </div>
                      <div className="text-xs text-zinc-500 space-y-1">
                        <p>通过率: {report!.passed}/{report!.total}</p>
                        <p>平均分: {Math.round(report!.averageScore * 100)}%</p>
                        <p>平均耗时: {(report!.performance.avgResponseTime / 1000).toFixed(1)}s</p>
                      </div>
                    </div>
                  </div>

                  <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">各 Case 得分</h4>
                  {report!.results.map(tc => (
                    <div key={tc.testId} className="bg-zinc-800 rounded-lg border border-zinc-800 p-3">
                      <div className="flex items-center gap-3 mb-1.5">
                        <span className="text-xs text-zinc-400 font-mono flex-1 truncate">{tc.testId}</span>
                        <span className={`text-sm font-bold font-mono ${
                          tc.score * 100 >= 80 ? 'text-emerald-400' : tc.score * 100 >= 60 ? 'text-amber-400' : 'text-red-400'
                        }`}>
                          {Math.round(tc.score * 100)}%
                        </span>
                      </div>
                      <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full ${
                            tc.score * 100 >= 80 ? 'bg-emerald-500' : tc.score * 100 >= 60 ? 'bg-amber-500' : 'bg-red-500'
                          }`}
                          style={{ width: `${Math.min(100, tc.score * 100)}%` }}
                        />
                      </div>
                      {tc.expectationResults && tc.expectationResults.length > 0 && (
                        <div className="mt-2 flex gap-1 flex-wrap">
                          {tc.expectationResults.map((exp, i) => (
                            <span key={i} className={`text-[9px] px-1.5 py-0.5 rounded ${
                              exp.passed ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
                            }`}>
                              {exp.expectation.type}: {exp.passed ? 'pass' : 'fail'}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {activeTab === 'ai-analysis' && (
            <div className="p-4">
              {!hasData ? (
                <EmptyGuide message="需要先运行评测" />
              ) : (
                (() => {
                  const failedCases = report!.results.filter(r => r.status === 'failed');
                  const partialCases = report!.results.filter(r => r.status === 'partial');
                  const totalDuration = report!.results.reduce((sum, r) => sum + r.duration, 0);
                  const avgDuration = report!.results.length > 0 ? totalDuration / report!.results.length : 0;
                  const avgScore = report!.averageScore;

                  // Aggregate failure reasons
                  const reasonCounts = new Map<string, number>();
                  for (const tc of failedCases) {
                    const reason = tc.failureReason || '未知原因';
                    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
                  }
                  const topReasons = [...reasonCounts.entries()]
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 5);

                  // Rule-based recommendations
                  const recommendations: Array<{ text: string; priority: string }> = [];
                  const timeoutCases = failedCases.filter(tc =>
                    (tc.failureReason || '').toLowerCase().includes('timeout') ||
                    (tc.failureReason || '').includes('超时') ||
                    tc.duration > 60000
                  );
                  if (timeoutCases.length > 0) {
                    recommendations.push({ text: `${timeoutCases.length} 个 Case 疑似超时，考虑增加超时时间或优化 Prompt 减少推理轮数`, priority: 'high' });
                  }
                  const toolFailCases = report!.results.filter(tc =>
                    tc.toolExecutions.some(t => !t.success)
                  );
                  if (toolFailCases.length > 0) {
                    recommendations.push({ text: `${toolFailCases.length} 个 Case 存在工具调用失败，检查工具定义和参数校验`, priority: 'high' });
                  }
                  if (partialCases.length > failedCases.length) {
                    recommendations.push({ text: '部分通过 Case 较多，考虑细化 Expectation 断言或增加重试逻辑', priority: 'medium' });
                  }
                  if (passRate >= 90) {
                    recommendations.push({ text: '通过率已较高，建议增加更高难度的 Case 以提升评测区分度', priority: 'low' });
                  }
                  if (passRate < 50) {
                    recommendations.push({ text: '通过率偏低，建议检查系统提示词和工具描述是否清晰', priority: 'high' });
                  }
                  if (recommendations.length === 0) {
                    recommendations.push({ text: '当前评测结果正常，建议持续运行多轮以验证稳定性', priority: 'low' });
                  }

                  const priorityStyle: Record<string, string> = {
                    high: 'border-red-500/20 bg-red-500/5 text-red-400',
                    medium: 'border-amber-500/20 bg-amber-500/5 text-amber-400',
                    low: 'border-emerald-500/20 bg-emerald-500/5 text-emerald-400',
                  };

                  return (
                    <div className="space-y-4">
                      {/* Summary stats */}
                      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4 space-y-3">
                        <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">实验统计摘要</h4>
                        <div className="grid grid-cols-4 gap-3">
                          {[
                            { label: '通过率', value: `${passRate}%`, color: passRate >= 80 ? 'text-emerald-400' : passRate >= 60 ? 'text-amber-400' : 'text-red-400' },
                            { label: '平均分', value: `${Math.round(avgScore * 100)}%`, color: avgScore * 100 >= 80 ? 'text-emerald-400' : avgScore * 100 >= 60 ? 'text-amber-400' : 'text-red-400' },
                            { label: '平均耗时', value: `${(avgDuration / 1000).toFixed(1)}s`, color: 'text-zinc-400' },
                            { label: '总耗时', value: `${(totalDuration / 1000).toFixed(0)}s`, color: 'text-zinc-400' },
                          ].map(s => (
                            <div key={s.label} className="bg-zinc-800 rounded-lg p-2.5">
                              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
                              <div className="text-[10px] text-zinc-500">{s.label}</div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Top failure reasons */}
                      {topReasons.length > 0 && (
                        <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4 space-y-3">
                          <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">
                            Top 失败原因（共 {failedCases.length} 个失败 Case）
                          </h4>
                          {topReasons.map(([reason, count], i) => (
                            <div key={i} className="flex items-start gap-3 bg-red-500/5 border border-red-500/10 rounded-lg p-3">
                              <span className="text-xs font-bold text-red-400 bg-red-500/10 rounded-full w-5 h-5 flex items-center justify-center shrink-0">
                                {count}
                              </span>
                              <p className="text-xs text-zinc-400 flex-1">{reason}</p>
                            </div>
                          ))}
                        </div>
                      )}

                      {/* AI recommendations */}
                      <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] p-4 space-y-3">
                        <h4 className="text-xs font-medium text-zinc-400 uppercase tracking-wide">优化建议</h4>
                        {recommendations.map((rec, i) => (
                          <div key={i} className={`border rounded-lg px-3 py-2 ${priorityStyle[rec.priority] || priorityStyle.low}`}>
                            <p className="text-xs">{rec.text}</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
