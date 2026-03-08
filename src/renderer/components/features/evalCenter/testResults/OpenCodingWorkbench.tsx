import React, { useState, useEffect, useCallback, useRef } from 'react';
import type { TestCaseResult } from '@shared/ipc';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CaseAnnotation {
  caseId: string;
  errorTypes: ErrorType[];
  rootCause: string;
  severity: 1 | 2 | 3 | 4 | 5;
  notes?: string;
}

type ErrorType =
  | 'planning_failure'
  | 'tool_selection_wrong'
  | 'execution_error'
  | 'output_format_wrong'
  | 'self_repair_failed';

const ERROR_TYPE_LABELS: Record<ErrorType, string> = {
  planning_failure: '规划失败',
  tool_selection_wrong: '工具选择错误',
  execution_error: '执行错误',
  output_format_wrong: '输出格式不符',
  self_repair_failed: '自修复失败',
};

const SEVERITY_LABELS: Record<number, { label: string; color: string }> = {
  1: { label: '轻微', color: 'text-zinc-400' },
  2: { label: '低', color: 'text-blue-400' },
  3: { label: '中', color: 'text-amber-400' },
  4: { label: '高', color: 'text-orange-400' },
  5: { label: '严重', color: 'text-red-400' },
};

// ── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  cases: TestCaseResult[];
  onSave: (annotations: CaseAnnotation[]) => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function getStatusColor(status: TestCaseResult['status']): string {
  switch (status) {
    case 'passed': return 'text-emerald-400';
    case 'partial': return 'text-amber-400';
    case 'failed': return 'text-red-400';
    default: return 'text-zinc-500';
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

// ── Component ─────────────────────────────────────────────────────────────────

export const OpenCodingWorkbench: React.FC<Props> = ({ cases, onSave }) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [annotations, setAnnotations] = useState<Map<string, CaseAnnotation>>(new Map());
  const rootCauseRef = useRef<HTMLTextAreaElement>(null);

  const selectedCase = cases[selectedIndex] ?? null;

  // Current annotation state for the selected case
  const currentAnnotation: CaseAnnotation = annotations.get(selectedCase?.testId ?? '') ?? {
    caseId: selectedCase?.testId ?? '',
    errorTypes: [],
    rootCause: '',
    severity: 3,
    notes: '',
  };

  const updateAnnotation = useCallback(
    (patch: Partial<CaseAnnotation>) => {
      if (!selectedCase) return;
      setAnnotations((prev) => {
        const next = new Map(prev);
        const existing = next.get(selectedCase.testId) ?? {
          caseId: selectedCase.testId,
          errorTypes: [],
          rootCause: '',
          severity: 3 as const,
          notes: '',
        };
        next.set(selectedCase.testId, { ...existing, ...patch });
        return next;
      });
    },
    [selectedCase]
  );

  const handleSaveAndNext = useCallback(() => {
    if (selectedIndex < cases.length - 1) {
      setSelectedIndex((i) => i + 1);
    }
  }, [selectedIndex, cases.length]);

  const handleSaveAll = () => {
    onSave(Array.from(annotations.values()));
  };

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't intercept when typing in input/textarea
      const target = e.target as HTMLElement;
      if (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT') {
        // Enter in textarea = save & next (only if Ctrl/Cmd held)
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          handleSaveAndNext();
        }
        return;
      }

      // Number keys 1-5 = set severity
      if (['1', '2', '3', '4', '5'].includes(e.key)) {
        updateAnnotation({ severity: parseInt(e.key) as 1 | 2 | 3 | 4 | 5 });
        return;
      }
      // Enter = save & next
      if (e.key === 'Enter') {
        handleSaveAndNext();
        return;
      }
      // j/k or arrow up/down = navigate cases
      if (e.key === 'j' || e.key === 'ArrowDown') {
        setSelectedIndex((i) => Math.min(i + 1, cases.length - 1));
      }
      if (e.key === 'k' || e.key === 'ArrowUp') {
        setSelectedIndex((i) => Math.max(i - 1, 0));
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [handleSaveAndNext, updateAnnotation, cases.length]);

  const annotatedCount = annotations.size;

  if (cases.length === 0) {
    return (
      <div className="flex items-center justify-center py-16 text-zinc-500 text-sm">
        没有需要标注的用例
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── Left panel: case list ── */}
      <div className="w-56 flex-shrink-0 border-r border-zinc-700/30 flex flex-col">
        {/* Header */}
        <div className="px-3 py-2 border-b border-zinc-700/20 flex items-center justify-between">
          <span className="text-xs font-medium text-zinc-300">用例列表</span>
          <span className="text-[10px] text-zinc-500">
            {annotatedCount}/{cases.length} 已标注
          </span>
        </div>

        {/* Progress bar */}
        <div className="h-0.5 bg-zinc-700/50">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${(annotatedCount / cases.length) * 100}%` }}
          />
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto">
          {cases.map((c, i) => {
            const isAnnotated = annotations.has(c.testId);
            const isSelected = i === selectedIndex;
            return (
              <button
                key={c.testId}
                onClick={() => setSelectedIndex(i)}
                className={`w-full text-left px-3 py-2 border-b border-zinc-700/10 transition ${
                  isSelected
                    ? 'bg-zinc-700/60 border-l-2 border-l-blue-500'
                    : 'hover:bg-zinc-800/50'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-mono text-[10px] text-zinc-300 truncate">{c.testId}</span>
                  <span className={`text-[10px] font-medium ${getStatusColor(c.status)}`}>
                    {Math.round(c.score * 100)}%
                  </span>
                </div>
                {isAnnotated && (
                  <div className="mt-0.5 flex items-center gap-1">
                    <span className="w-1.5 h-1.5 rounded-full bg-blue-500 inline-block" />
                    <span className="text-[9px] text-zinc-500">已标注</span>
                  </div>
                )}
              </button>
            );
          })}
        </div>

        {/* Save all */}
        <div className="p-2 border-t border-zinc-700/30">
          <button
            onClick={handleSaveAll}
            disabled={annotatedCount === 0}
            className="w-full py-1.5 rounded bg-blue-600 hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-xs font-medium transition"
          >
            保存全部 ({annotatedCount})
          </button>
        </div>
      </div>

      {/* ── Right panel: annotation ── */}
      {selectedCase ? (
        <div className="flex-1 overflow-y-auto flex flex-col min-h-0">
          {/* Case header */}
          <div className="px-4 py-3 border-b border-zinc-700/20 flex items-start justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm text-zinc-200">{selectedCase.testId}</span>
                <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                  selectedCase.status === 'passed' ? 'bg-emerald-500/15 text-emerald-400' :
                  selectedCase.status === 'partial' ? 'bg-amber-500/15 text-amber-400' :
                  'bg-red-500/15 text-red-400'
                }`}>
                  {selectedCase.status}
                </span>
                <span className="text-xs text-zinc-500">{Math.round(selectedCase.score * 100)}% · {formatDuration(selectedCase.duration)}</span>
              </div>
              <p className="text-xs text-zinc-400 mt-0.5 line-clamp-2">{selectedCase.description}</p>
            </div>
            <span className="text-[10px] text-zinc-600 flex-shrink-0 ml-4">
              {selectedIndex + 1} / {cases.length}
            </span>
          </div>

          <div className="flex-1 px-4 py-3 space-y-4">
            {/* Failure reason */}
            {selectedCase.failureReason && (
              <div className="bg-red-900/20 border border-red-700/30 rounded-lg px-3 py-2">
                <div className="text-[10px] text-red-400/70 mb-1 font-medium uppercase tracking-wide">失败原因</div>
                <p className="text-xs text-red-300/80">{selectedCase.failureReason}</p>
              </div>
            )}

            {/* Tool call chain */}
            {selectedCase.toolExecutions && selectedCase.toolExecutions.length > 0 && (
              <div>
                <div className="text-[10px] text-zinc-500 mb-1.5 font-medium uppercase tracking-wide">
                  工具调用链 ({selectedCase.toolExecutions.length})
                </div>
                <div className="space-y-1">
                  {selectedCase.toolExecutions.map((ex, i) => (
                    <div
                      key={i}
                      className={`flex items-start gap-2 px-2 py-1.5 rounded border text-[10px] ${
                        ex.success
                          ? 'bg-zinc-800/40 border-zinc-700/20'
                          : 'bg-red-900/15 border-red-700/20'
                      }`}
                    >
                      <span className={`flex-shrink-0 w-3.5 h-3.5 mt-0.5 font-bold ${ex.success ? 'text-emerald-400' : 'text-red-400'}`}>
                        {ex.success ? '✓' : '✗'}
                      </span>
                      <div className="min-w-0">
                        <span className="font-mono font-medium text-zinc-300">{ex.tool}</span>
                        {Object.keys(ex.input).length > 0 && (
                          <span className="text-zinc-500 ml-1 truncate">
                            {Object.entries(ex.input)
                              .map(([k, v]) => `${k}=${JSON.stringify(v).slice(0, 20)}`)
                              .join(' ')
                              .slice(0, 60)}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Annotation form ── */}
            <div className="border-t border-zinc-700/30 pt-4 space-y-3">
              <div className="text-[10px] text-zinc-500 font-medium uppercase tracking-wide">标注面板</div>

              {/* Error types */}
              <div>
                <div className="text-xs text-zinc-400 mb-1.5">错误类型（可多选）</div>
                <div className="flex flex-wrap gap-1.5">
                  {(Object.keys(ERROR_TYPE_LABELS) as ErrorType[]).map((et) => {
                    const isChecked = currentAnnotation.errorTypes.includes(et);
                    return (
                      <button
                        key={et}
                        onClick={() => {
                          const next = isChecked
                            ? currentAnnotation.errorTypes.filter((x) => x !== et)
                            : [...currentAnnotation.errorTypes, et];
                          updateAnnotation({ errorTypes: next });
                        }}
                        className={`px-2 py-1 rounded text-[10px] border transition ${
                          isChecked
                            ? 'bg-blue-500/20 border-blue-500/50 text-blue-300'
                            : 'bg-zinc-800/50 border-zinc-700/30 text-zinc-400 hover:border-zinc-600'
                        }`}
                      >
                        {ERROR_TYPE_LABELS[et]}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Root cause */}
              <div>
                <div className="text-xs text-zinc-400 mb-1.5">根因分析</div>
                <textarea
                  ref={rootCauseRef}
                  rows={3}
                  value={currentAnnotation.rootCause}
                  onChange={(e) => updateAnnotation({ rootCause: e.target.value })}
                  placeholder="描述根本原因..."
                  className="w-full bg-zinc-800/60 border border-zinc-700/40 rounded-lg px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-zinc-600"
                />
              </div>

              {/* Severity */}
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <div className="text-xs text-zinc-400">严重程度</div>
                  <div className={`text-xs font-medium ${SEVERITY_LABELS[currentAnnotation.severity].color}`}>
                    {currentAnnotation.severity} — {SEVERITY_LABELS[currentAnnotation.severity].label}
                  </div>
                </div>
                <div className="flex items-center gap-1.5">
                  {([1, 2, 3, 4, 5] as const).map((n) => (
                    <button
                      key={n}
                      onClick={() => updateAnnotation({ severity: n })}
                      className={`flex-1 py-1.5 rounded text-xs font-bold transition ${
                        currentAnnotation.severity === n
                          ? `${SEVERITY_LABELS[n].color} bg-zinc-700`
                          : 'text-zinc-600 bg-zinc-800/60 hover:bg-zinc-700/50'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <div className="text-[9px] text-zinc-600 mt-1">快捷键：数字键 1-5 设置等级</div>
              </div>

              {/* Notes */}
              <div>
                <div className="text-xs text-zinc-400 mb-1.5">备注（可选）</div>
                <textarea
                  rows={2}
                  value={currentAnnotation.notes ?? ''}
                  onChange={(e) => updateAnnotation({ notes: e.target.value })}
                  placeholder="其他备注..."
                  className="w-full bg-zinc-800/60 border border-zinc-700/40 rounded-lg px-2.5 py-2 text-xs text-zinc-200 placeholder-zinc-600 resize-none focus:outline-none focus:border-zinc-600"
                />
              </div>
            </div>
          </div>

          {/* Bottom action bar */}
          <div className="px-4 py-3 border-t border-zinc-700/30 flex items-center justify-between">
            <div className="text-[10px] text-zinc-600">
              Enter 保存并下一条 · Ctrl+Enter（文本框内）· j/k 导航
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => setSelectedIndex((i) => Math.max(i - 1, 0))}
                disabled={selectedIndex === 0}
                className="px-2.5 py-1 rounded text-xs text-zinc-400 bg-zinc-800 hover:bg-zinc-700 disabled:opacity-30 transition"
              >
                ← 上一个
              </button>
              <button
                onClick={handleSaveAndNext}
                disabled={selectedIndex === cases.length - 1}
                className="px-3 py-1 rounded text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-40 transition"
              >
                保存 → 下一个
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-zinc-500 text-sm">
          请从左侧选择用例
        </div>
      )}
    </div>
  );
};
