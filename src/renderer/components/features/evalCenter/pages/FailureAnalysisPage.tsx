import React, { useState, useCallback, useEffect } from 'react';
import { FailureFunnel } from '../testResults/FailureFunnel';
import { OpenCodingWorkbench } from '../testResults/OpenCodingWorkbench';
import type { CaseAnnotation } from '../testResults/OpenCodingWorkbench';
import type { TestRunReport, TestCaseResult, EvalAnnotationErrorType, AxialCodingEntryIpc } from '@shared/ipc';
import { EVALUATION_CHANNELS } from '@shared/ipc';

type FailureView = 'funnel' | 'coding' | 'axial';

export const FailureAnalysisPage: React.FC = () => {
  const [view, setView] = useState<FailureView>('funnel');
  const [cases, setCases] = useState<TestCaseResult[]>([]);
  const [allCases, setAllCases] = useState<TestCaseResult[]>([]);
  const [axialData, setAxialData] = useState<AxialCodingEntryIpc[]>([]);
  const [axialLoading, setAxialLoading] = useState(false);

  const loadFailedCases = useCallback(async () => {
    try {
      const list = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LIST_TEST_REPORTS) as { filePath: string }[] | undefined;
      if (list && list.length > 0) {
        const report = await window.electronAPI?.invoke(EVALUATION_CHANNELS.LOAD_TEST_REPORT, list[0].filePath) as TestRunReport | null | undefined;
        if (report) {
          setAllCases(report.results);
          setCases(report.results.filter((r: TestCaseResult) => r.status !== 'passed'));
        }
      }
    } catch { /* best-effort */ }
  }, []);

  useEffect(() => { loadFailedCases(); }, [loadFailedCases]);

  // Load axial coding data when switching to that tab
  const loadAxialData = useCallback(async () => {
    setAxialLoading(true);
    try {
      const result = await window.electronAPI?.invoke(
        EVALUATION_CHANNELS.GET_AXIAL_CODING as 'evaluation:get-axial-coding'
      );
      if (result && Array.isArray(result)) {
        setAxialData(result as unknown as AxialCodingEntryIpc[]);
      }
    } catch {
      setAxialData([]);
    } finally {
      setAxialLoading(false);
    }
  }, []);

  useEffect(() => {
    if (view === 'axial') {
      loadAxialData();
    }
  }, [view, loadAxialData]);

  const handleSave = useCallback(async (annotations: CaseAnnotation[]) => {
    try {
      await Promise.all(
        annotations.map((ann, i) =>
          window.electronAPI?.invoke(EVALUATION_CHANNELS.SAVE_ANNOTATIONS, {
            id: `${ann.caseId}-${Date.now()}-${i}`,
            caseId: ann.caseId,
            round: 1,
            timestamp: new Date().toISOString(),
            errorTypes: ann.errorTypes.map((t: string): EvalAnnotationErrorType => {
              const map: Record<string, EvalAnnotationErrorType> = {
                tool_selection_wrong: 'tool_misuse',
                planning_failure: 'reasoning_error',
                execution_error: 'reasoning_error',
                output_format_wrong: 'incomplete_output',
                self_repair_failed: 'hallucination',
              };
              return map[t] || 'incomplete_output';
            }),
            rootCause: ann.rootCause || ann.notes || 'N/A',
            severity: ann.severity,
            annotator: 'failure-analysis',
          })
        )
      );
    } catch (err) {
      console.error('[FailureAnalysis] save failed', err);
    }
  }, []);

  const SEVERITY_COLORS: Record<string, string> = {
    high: 'text-red-400 bg-red-500/10',
    medium: 'text-amber-400 bg-amber-500/10',
    low: 'text-emerald-400 bg-emerald-500/10',
  };

  const getSeverityLabel = (avgSeverity: number): { label: string; key: string } => {
    if (avgSeverity >= 4) return { label: 'high', key: 'high' };
    if (avgSeverity >= 2.5) return { label: 'medium', key: 'medium' };
    return { label: 'low', key: 'low' };
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sub-nav */}
      <div className="flex gap-1 px-4 pt-3 border-b border-zinc-700/30">
        {([
          { key: 'funnel' as const, label: '失败漏斗', icon: '\u{1F4CA}' },
          { key: 'coding' as const, label: 'Open Coding', icon: '\u{1F3F7}\uFE0F' },
          { key: 'axial' as const, label: 'Axial Coding', icon: '\u{1F300}' },
        ]).map(tab => (
          <button
            key={tab.key}
            onClick={() => setView(tab.key)}
            className={`px-3 py-2 text-xs transition border-b-2 flex items-center gap-1.5 ${
              view === tab.key
                ? 'text-zinc-200 border-blue-500'
                : 'text-zinc-500 hover:text-zinc-300 border-transparent'
            }`}
          >
            <span>{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto">
        {view === 'funnel' && (
          <div className="p-4">
            {allCases.length > 0 ? (
              <FailureFunnel cases={allCases} />
            ) : (
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-14 h-14 rounded-2xl bg-zinc-800/60 border border-white/[0.04] flex items-center justify-center text-2xl">
                  {'\u{1F4CA}'}
                </div>
                <p className="text-sm text-zinc-400">运行评测后，失败漏斗数据将出现在此</p>
                <p className="text-xs text-zinc-600 max-w-sm text-center">
                  失败漏斗按阶段展示 Case 的通过/失败分布，帮助定位系统性问题
                </p>
              </div>
            )}
          </div>
        )}
        {view === 'coding' && (
          cases.length > 0 ? (
            <OpenCodingWorkbench cases={cases} onSave={handleSave} />
          ) : (
            <div className="p-4">
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-14 h-14 rounded-2xl bg-zinc-800/60 border border-white/[0.04] flex items-center justify-center text-2xl">
                  {'\u{1F3F7}\uFE0F'}
                </div>
                <p className="text-sm text-zinc-400">暂无失败 Case</p>
                <p className="text-xs text-zinc-600 max-w-sm text-center">
                  {allCases.length > 0
                    ? '当前所有 Case 均已通过，无需标注'
                    : '运行评测后，失败的 Case 将出现在此进行 Open Coding 标注'}
                </p>
              </div>
            </div>
          )
        )}
        {view === 'axial' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="text-sm font-medium text-zinc-200">Axial Coding 聚类</h4>
              {axialData.length > 0 && (
                <button
                  onClick={loadAxialData}
                  className="text-[10px] text-zinc-500 hover:text-zinc-300 transition"
                >
                  刷新
                </button>
              )}
            </div>
            <p className="text-xs text-zinc-500">
              根据 Open Coding 标注结果自动聚类，识别高频错误模式
            </p>

            {axialLoading && (
              <div className="flex items-center justify-center py-12 gap-3">
                <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span className="text-sm text-zinc-500">加载聚类数据...</span>
              </div>
            )}

            {!axialLoading && axialData.length === 0 && (
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-14 h-14 rounded-2xl bg-zinc-800/60 border border-white/[0.04] flex items-center justify-center text-2xl">
                  {'\u{1F300}'}
                </div>
                <p className="text-sm text-zinc-400">暂无聚类数据</p>
                <p className="text-xs text-zinc-600 max-w-sm text-center">
                  完成 Open Coding 标注后，聚类结果将自动生成。请先在 Open Coding 页面标注失败 Case。
                </p>
              </div>
            )}

            {!axialLoading && axialData.length > 0 && (() => {
              // Build cross-tabulation: errorType (rows) x case category (columns)
              const errorTypes = [...new Set(axialData.map(e => e.errorType))];
              const caseCategories = new Map<string, Set<string>>();
              const matrix = new Map<string, Map<string, number>>();

              for (const entry of axialData) {
                if (!matrix.has(entry.errorType)) matrix.set(entry.errorType, new Map());
                const row = matrix.get(entry.errorType)!;
                for (const caseId of entry.caseIds) {
                  const cat = caseId.split('-')[0] || 'other';
                  if (!caseCategories.has(cat)) caseCategories.set(cat, new Set());
                  caseCategories.get(cat)!.add(caseId);
                  row.set(cat, (row.get(cat) || 0) + 1);
                }
              }

              const categories = [...caseCategories.keys()].sort();
              const ERROR_LABELS: Record<string, string> = {
                tool_misuse: '工具误用',
                reasoning_error: '推理错误',
                incomplete_output: '输出不完整',
                hallucination: '幻觉',
                security_violation: '安全违规',
              };

              return (
                <div className="space-y-4">
                  {/* Summary cards */}
                  <div className="grid grid-cols-3 gap-2">
                    {axialData.map((entry, i) => {
                      const sev = getSeverityLabel(entry.avgSeverity);
                      return (
                        <div key={i} className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 p-2.5">
                          <div className="flex items-center gap-2 mb-1">
                            <span className="text-[11px] text-zinc-200 font-medium">{ERROR_LABELS[entry.errorType] || entry.errorType}</span>
                            <span className={`text-[9px] px-1 py-0.5 rounded-full ${SEVERITY_COLORS[sev.key] || SEVERITY_COLORS.medium}`}>
                              {sev.label}
                            </span>
                          </div>
                          <span className="text-lg font-bold text-zinc-300">{entry.count}</span>
                          <span className="text-[10px] text-zinc-500 ml-1">case{entry.count > 1 ? 's' : ''}</span>
                        </div>
                      );
                    })}
                  </div>

                  {/* Cross-tabulation matrix */}
                  <div className="bg-zinc-800/40 rounded-lg border border-zinc-700/30 overflow-hidden">
                    <div className="px-3 py-2 border-b border-zinc-700/20">
                      <span className="text-xs font-medium text-zinc-300">交叉分析矩阵</span>
                      <span className="text-[10px] text-zinc-500 ml-2">
                        {errorTypes.length} 种错误类型 x {categories.length} 个用例分类
                      </span>
                    </div>
                    <div className="overflow-x-auto">
                      <table className="text-[10px] text-zinc-400 border-collapse w-full">
                        <thead>
                          <tr>
                            <th className="px-3 py-2 text-left font-medium text-zinc-500 bg-zinc-900/30 sticky left-0 min-w-[120px]">
                              错误类型 \ 用例分类
                            </th>
                            {categories.map(cat => (
                              <th key={cat} className="px-2 py-2 text-center font-medium text-zinc-400 bg-zinc-900/30 min-w-[60px]">
                                {cat}
                              </th>
                            ))}
                            <th className="px-2 py-2 text-center font-medium text-blue-400/80 bg-zinc-900/30 min-w-[50px]">
                              合计
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {errorTypes.map(et => {
                            const row = matrix.get(et) || new Map();
                            const rowTotal = [...row.values()].reduce((a, b) => a + b, 0);
                            return (
                              <tr key={et} className="border-t border-zinc-700/10 hover:bg-zinc-800/30">
                                <td className="px-3 py-1.5 font-medium text-zinc-300 sticky left-0 bg-zinc-900/60 backdrop-blur">
                                  {ERROR_LABELS[et] || et}
                                </td>
                                {categories.map(cat => {
                                  const count = row.get(cat) || 0;
                                  return (
                                    <td key={cat} className={`px-2 py-1.5 text-center font-mono ${
                                      count > 0
                                        ? count >= 3 ? 'text-red-400 bg-red-500/10' : count >= 2 ? 'text-amber-400 bg-amber-500/5' : 'text-zinc-300'
                                        : 'text-zinc-600'
                                    }`}>
                                      {count || '-'}
                                    </td>
                                  );
                                })}
                                <td className="px-2 py-1.5 text-center font-mono font-medium text-blue-300">
                                  {rowTotal}
                                </td>
                              </tr>
                            );
                          })}
                          {/* Column totals */}
                          <tr className="border-t border-zinc-700/30">
                            <td className="px-3 py-1.5 font-medium text-blue-400/80 sticky left-0 bg-zinc-900/60 backdrop-blur">
                              合计
                            </td>
                            {categories.map(cat => {
                              const colTotal = errorTypes.reduce((sum, et) => sum + ((matrix.get(et) || new Map()).get(cat) || 0), 0);
                              return (
                                <td key={cat} className="px-2 py-1.5 text-center font-mono font-medium text-blue-300">
                                  {colTotal}
                                </td>
                              );
                            })}
                            <td className="px-2 py-1.5 text-center font-mono font-bold text-blue-200">
                              {axialData.reduce((sum, e) => sum + e.count, 0)}
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        )}
      </div>
    </div>
  );
};
