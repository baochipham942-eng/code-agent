import React, { useState, useMemo } from 'react';
import type { TestCaseResult } from '@shared/ipc';

// ---------- AI Analysis helpers (rule-based, no LLM) ----------

interface ToolPattern {
  tool: string;
  count: number;
  successCount: number;
  failCount: number;
  avgDuration: number;
}

interface AIAnalysis {
  failureReasons: string[];
  toolPatterns: ToolPattern[];
  suggestions: string[];
}

function analyzeTestCase(result: TestCaseResult): AIAnalysis {
  const failureReasons: string[] = [];
  const suggestions: string[] = [];

  // Failure reasons
  if (result.failureReason) {
    failureReasons.push(result.failureReason);
  }
  if (result.failureStage) {
    failureReasons.push(`失败阶段: ${result.failureStage}`);
  }
  if (result.errors?.length) {
    result.errors.forEach(e => failureReasons.push(e));
  }
  const failedExpectations = result.expectationResults?.filter(er => !er.passed) || [];
  if (failedExpectations.length > 0) {
    failedExpectations.forEach(er => {
      failureReasons.push(
        `[${er.expectation.type}] ${er.expectation.description} — 期望: ${er.evidence.expected}, 实际: ${er.evidence.actual}`
      );
    });
  }

  // Tool patterns
  const toolMap = new Map<string, { count: number; successCount: number; failCount: number; totalDuration: number }>();
  for (const te of result.toolExecutions || []) {
    const entry = toolMap.get(te.tool) || { count: 0, successCount: 0, failCount: 0, totalDuration: 0 };
    entry.count++;
    if (te.success) entry.successCount++;
    else entry.failCount++;
    entry.totalDuration += te.duration;
    toolMap.set(te.tool, entry);
  }
  const toolPatterns: ToolPattern[] = Array.from(toolMap.entries())
    .map(([tool, data]) => ({
      tool,
      count: data.count,
      successCount: data.successCount,
      failCount: data.failCount,
      avgDuration: Math.round(data.totalDuration / data.count),
    }))
    .sort((a, b) => b.count - a.count);

  // Rule-based suggestions
  const totalToolCalls = result.toolExecutions?.length || 0;
  const failedToolCalls = result.toolExecutions?.filter(t => !t.success).length || 0;

  if (failedToolCalls > 0 && totalToolCalls > 0) {
    const failRate = failedToolCalls / totalToolCalls;
    if (failRate > 0.5) {
      suggestions.push('超过半数工具调用失败，建议检查工具参数格式和权限配置');
    } else if (failedToolCalls >= 2) {
      suggestions.push('多次工具调用失败，建议检查工具参数格式');
    }
  }

  if (result.turnCount > 10) {
    suggestions.push(`对话轮次较多 (${result.turnCount} 轮)，建议优化提示词以减少不必要的交互`);
  }

  if (result.duration > 60000) {
    suggestions.push(`执行时间较长 (${Math.round(result.duration / 1000)}s)，建议检查是否存在不必要的重试或等待`);
  }

  const criticalFailed = failedExpectations.filter(er => er.expectation.critical);
  if (criticalFailed.length > 0) {
    suggestions.push(`${criticalFailed.length} 个关键断言失败，这些是必须通过的核心要求`);
  }

  if (result.status === 'partial') {
    const passedCount = result.expectationResults?.filter(er => er.passed).length || 0;
    const totalCount = result.expectationResults?.length || 0;
    suggestions.push(`部分通过 (${passedCount}/${totalCount})，检查未通过的断言是否有优先级差异`);
  }

  if (toolPatterns.some(tp => tp.count >= 5 && tp.failCount > 0)) {
    const repeatedTool = toolPatterns.find(tp => tp.count >= 5 && tp.failCount > 0);
    if (repeatedTool) {
      suggestions.push(`工具 "${repeatedTool.tool}" 被调用 ${repeatedTool.count} 次且有失败，可能存在重试循环`);
    }
  }

  if (suggestions.length === 0 && result.status === 'passed') {
    suggestions.push('测试用例执行正常，无需调整');
  }

  return { failureReasons, toolPatterns, suggestions };
}

// ---------- Score color helpers ----------

function getScoreColor(score: number): string {
  if (score >= 0.8) return 'text-emerald-400';
  if (score >= 0.6) return 'text-amber-400';
  return 'text-red-400';
}

function getScoreBg(score: number): string {
  if (score >= 0.8) return 'bg-emerald-500/10 border-emerald-500/20';
  if (score >= 0.6) return 'bg-amber-500/10 border-amber-500/20';
  return 'bg-red-500/10 border-red-500/20';
}

function getStatusBadge(status: string): { label: string; className: string } {
  switch (status) {
    case 'passed': return { label: 'PASS', className: 'bg-emerald-500/20 text-emerald-400' };
    case 'failed': return { label: 'FAIL', className: 'bg-red-500/20 text-red-400' };
    case 'partial': return { label: 'PARTIAL', className: 'bg-amber-500/20 text-amber-400' };
    case 'skipped': return { label: 'SKIP', className: 'bg-active/20 text-text-secondary' };
    default: return { label: status.toUpperCase(), className: 'bg-active/20 text-text-secondary' };
  }
}

// ---------- Component ----------

type TabKey = 'expectations' | 'tools' | 'responses' | 'grader' | 'analysis';

interface Props {
  result: TestCaseResult;
}

export const TestResultsDetail: React.FC<Props> = ({ result }) => {
  const [activeTab, setActiveTab] = useState<TabKey>('expectations');

  const analysis = useMemo(() => analyzeTestCase(result), [result]);

  const tabs: { key: TabKey; label: string; count?: number }[] = [
    { key: 'expectations', label: '断言', count: result.expectationResults?.length || 0 },
    { key: 'tools', label: '工具调用', count: result.toolExecutions?.length || 0 },
    { key: 'responses', label: '响应', count: result.responses?.length || 0 },
    { key: 'grader', label: '评分' },
    { key: 'analysis', label: 'AI 分析' },
  ];

  const statusBadge = getStatusBadge(result.status);

  return (
    <div className="bg-deep border-t border-border-default/20 p-3">
      {/* Error display */}
      {result.errors?.length > 0 && (
        <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-[11px] text-red-400">
          {result.errors.map((e, i) => <div key={i}>{e}</div>)}
        </div>
      )}

      {/* Failure reason */}
      {result.failureReason && (
        <div className="mb-3 p-2 bg-red-500/10 border border-red-500/20 rounded text-[11px] text-red-400">
          失败原因: {result.failureReason}
        </div>
      )}

      {/* Tabs */}
      <div className="flex items-center gap-1 mb-3">
        {tabs.map(tab => (
          <button
            key={tab.key}
            onClick={() => setActiveTab(tab.key)}
            className={`px-2 py-1 rounded text-[11px] transition ${
              activeTab === tab.key
                ? 'bg-active text-text-primary'
                : 'text-text-tertiary hover:text-text-secondary hover:bg-hover'
            }`}
          >
            {tab.label}{tab.count !== undefined ? ` (${tab.count})` : ''}
          </button>
        ))}
      </div>

      {/* Expectations tab */}
      {activeTab === 'expectations' && (
        <div className="space-y-1.5">
          {result.expectationResults?.length ? (
            result.expectationResults.map((er, i) => (
              <div
                key={i}
                className={`flex items-start gap-2 p-2 rounded text-[11px] ${
                  er.passed ? 'bg-emerald-500/5 border border-emerald-500/10' : 'bg-red-500/5 border border-red-500/10'
                }`}
              >
                <span className={`flex-shrink-0 mt-0.5 ${er.passed ? 'text-emerald-400' : 'text-red-400'}`}>
                  {er.passed ? '\u2713' : '\u2717'}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-text-secondary">
                    <span className="font-mono text-text-tertiary">[{er.expectation.type}]</span>{' '}
                    {er.expectation.description}
                    {er.expectation.critical && (
                      <span className="ml-1 text-[10px] text-red-400 font-medium">CRITICAL</span>
                    )}
                  </div>
                  <div className="text-text-tertiary mt-0.5">
                    期望: {er.evidence.expected} · 实际: {er.evidence.actual}
                  </div>
                </div>
                {er.expectation.weight !== 1 && (
                  <span className="text-[10px] text-text-disabled flex-shrink-0">w={er.expectation.weight}</span>
                )}
              </div>
            ))
          ) : (
            <div className="text-text-disabled text-[11px]">无断言结果</div>
          )}
        </div>
      )}

      {/* Tools tab */}
      {activeTab === 'tools' && (
        <div className="space-y-1.5">
          {result.toolExecutions?.length ? (
            result.toolExecutions.map((te, i) => (
              <div key={i} className="p-2 bg-surface border border-border-default/20 rounded text-[11px]">
                <div className="flex items-center gap-2">
                  <span className={`font-mono font-medium ${te.success ? 'text-emerald-400' : 'text-red-400'}`}>
                    {te.tool}
                  </span>
                  <span className="text-text-disabled">{te.duration}ms</span>
                </div>
                {te.input && (
                  <pre className="mt-1 text-text-tertiary overflow-x-auto max-h-20 text-[10px]">
                    {typeof te.input === 'string' ? te.input : JSON.stringify(te.input, null, 2)}
                  </pre>
                )}
                {te.output && (
                  <pre className="mt-1 text-text-secondary overflow-x-auto max-h-20 text-[10px] whitespace-pre-wrap">
                    {typeof te.output === 'string' ? te.output.slice(0, 500) : JSON.stringify(te.output).slice(0, 500)}
                    {(typeof te.output === 'string' ? te.output.length : JSON.stringify(te.output).length) > 500 && '...'}
                  </pre>
                )}
              </div>
            ))
          ) : (
            <div className="text-text-disabled text-[11px]">无工具调用</div>
          )}
        </div>
      )}

      {/* Responses tab */}
      {activeTab === 'responses' && (
        <div className="space-y-1.5">
          {result.responses?.length ? (
            result.responses.map((resp, i) => (
              <div key={i} className="p-2 bg-surface border border-border-default/20 rounded text-[11px] text-text-secondary whitespace-pre-wrap max-h-32 overflow-y-auto">
                {resp}
              </div>
            ))
          ) : (
            <div className="text-text-disabled text-[11px]">无响应</div>
          )}
        </div>
      )}

      {/* Grader (评分) tab */}
      {activeTab === 'grader' && (
        <div className="space-y-3">
          {/* Overall score card */}
          <div className={`p-4 rounded-lg border ${getScoreBg(result.score)}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <span className={`text-3xl font-bold font-mono ${getScoreColor(result.score)}`}>
                  {typeof result.score === 'number' ? (result.score * 100).toFixed(0) : '—'}
                </span>
                <div>
                  <div className="text-[11px] text-text-secondary">综合得分</div>
                  <div className="text-[10px] text-text-tertiary mt-0.5">
                    耗时 {(result.duration / 1000).toFixed(1)}s · {result.turnCount} 轮对话
                  </div>
                </div>
              </div>
              <span className={`text-[11px] font-bold px-2.5 py-1 rounded ${statusBadge.className}`}>
                {statusBadge.label}
              </span>
            </div>
          </div>

          {/* Expectation score breakdown */}
          {result.expectationResults && result.expectationResults.length > 0 && (
            <div>
              <div className="text-[11px] text-text-secondary font-medium mb-2">断言评分明细</div>
              <div className="grid grid-cols-2 gap-2">
                {result.expectationResults.map((er, i) => {
                  const score = er.passed ? 1.0 : 0.0;
                  return (
                    <div
                      key={i}
                      className={`bg-surface rounded-lg border border-border-subtle border-t-2 ${
                        er.passed ? 'border-t-emerald-500/60' : 'border-t-red-500/60'
                      } p-3 flex flex-col justify-between min-h-[80px]`}
                    >
                      <div>
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-[11px] font-medium text-text-primary truncate max-w-[70%]">
                            {er.expectation.description}
                          </span>
                          {er.expectation.weight !== 1 && (
                            <span className="text-[10px] text-text-tertiary">w={er.expectation.weight}</span>
                          )}
                        </div>
                        <div className="text-[10px] text-text-tertiary">
                          <span className="font-mono">[{er.expectation.type}]</span>
                          {er.expectation.critical && (
                            <span className="ml-1 text-red-400 font-medium">CRITICAL</span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center justify-between mt-2">
                        <span className={`text-lg font-bold font-mono ${getScoreColor(score)}`}>
                          {er.passed ? '100' : '0'}
                        </span>
                        <span className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                          er.passed ? 'bg-emerald-500/20 text-emerald-400' : 'bg-red-500/20 text-red-400'
                        }`}>
                          {er.passed ? 'PASS' : 'FAIL'}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Summary stats */}
          <div className="grid grid-cols-4 gap-2">
            {[
              { label: '通过', value: result.expectationResults?.filter(er => er.passed).length || 0, color: 'text-emerald-400' },
              { label: '失败', value: result.expectationResults?.filter(er => !er.passed).length || 0, color: 'text-red-400' },
              { label: '工具调用', value: result.toolExecutions?.length || 0, color: 'text-blue-400' },
              { label: '对话轮次', value: result.turnCount, color: 'text-text-secondary' },
            ].map(stat => (
              <div key={stat.label} className="bg-surface rounded p-2 text-center">
                <div className={`text-lg font-bold font-mono ${stat.color}`}>{stat.value}</div>
                <div className="text-[10px] text-text-tertiary">{stat.label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* AI Analysis (AI 分析) tab */}
      {activeTab === 'analysis' && (
        <div className="space-y-3">
          {/* Failure reasons */}
          {analysis.failureReasons.length > 0 && (
            <div className="bg-surface rounded-lg border border-border-subtle p-3">
              <div className="text-[11px] font-medium text-red-400 mb-2">失败原因分析</div>
              <div className="space-y-1.5">
                {analysis.failureReasons.map((reason, i) => (
                  <div key={i} className="flex items-start gap-2 text-[11px]">
                    <span className="text-red-400/60 mt-0.5 flex-shrink-0">•</span>
                    <span className="text-text-secondary">{reason}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Tool usage patterns */}
          {analysis.toolPatterns.length > 0 && (
            <div className="bg-surface rounded-lg border border-border-subtle p-3">
              <div className="text-[11px] font-medium text-blue-400 mb-2">工具调用模式</div>
              <div className="space-y-1">
                {analysis.toolPatterns.map((tp, i) => (
                  <div key={i} className="flex items-center justify-between text-[11px] py-1 border-b border-border-default/20 last:border-0">
                    <span className="font-mono text-text-secondary">{tp.tool}</span>
                    <div className="flex items-center gap-3">
                      <span className="text-text-tertiary">{tp.count}x</span>
                      {tp.successCount > 0 && (
                        <span className="text-emerald-400/80">{tp.successCount} ok</span>
                      )}
                      {tp.failCount > 0 && (
                        <span className="text-red-400/80">{tp.failCount} fail</span>
                      )}
                      <span className="text-text-disabled text-[10px]">avg {tp.avgDuration}ms</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* No tool calls */}
          {analysis.toolPatterns.length === 0 && (
            <div className="bg-surface rounded-lg border border-border-subtle p-3">
              <div className="text-[11px] font-medium text-blue-400 mb-2">工具调用模式</div>
              <div className="text-text-disabled text-[11px]">无工具调用记录</div>
            </div>
          )}

          {/* Suggestions */}
          <div className="bg-surface rounded-lg border border-border-subtle p-3">
            <div className="text-[11px] font-medium text-amber-400 mb-2">建议</div>
            <div className="space-y-1.5">
              {analysis.suggestions.map((suggestion, i) => (
                <div key={i} className="flex items-start gap-2 text-[11px]">
                  <span className="text-amber-400/60 mt-0.5 flex-shrink-0">›</span>
                  <span className="text-text-secondary">{suggestion}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Deep AI analysis placeholder button */}
          <button
            onClick={() => alert('Coming soon: LLM-powered deep analysis')}
            className="w-full py-2 rounded-lg border border-border-subtle bg-elevated/20 text-[11px] text-text-secondary hover:text-text-primary hover:bg-surface transition flex items-center justify-center gap-1.5"
          >
            <span className="text-sm">&#x2728;</span>
            深度 AI 分析
          </button>
        </div>
      )}

      {/* Reference solution */}
      {result.reference_solution && (
        <div className="mt-3 p-2 bg-blue-500/5 border border-blue-500/10 rounded text-[11px]">
          <span className="text-blue-400 font-medium">参考方案:</span>{' '}
          <span className="text-text-secondary">{result.reference_solution}</span>
        </div>
      )}
    </div>
  );
};
