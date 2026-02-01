// ============================================================================
// EvaluationPanel - 评测面板主组件
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { RadarChart } from './RadarChart';
import { MetricCard } from './MetricCard';
import type {
  EvaluationResult,
  EvaluationExportFormat,
} from '../../../../shared/types/evaluation';
import {
  GRADE_COLORS,
  GRADE_BG_COLORS,
} from '../../../../shared/types/evaluation';
import { IPC_CHANNELS } from '../../../../shared/ipc';

interface EvaluationPanelProps {
  sessionId: string;
  onClose: () => void;
}

export function EvaluationPanel({ sessionId, onClose }: EvaluationPanelProps) {
  const [result, setResult] = useState<EvaluationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const runEvaluation = useCallback(async () => {
    if (!window.electronAPI) {
      setError('Electron API 不可用');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const evalResult = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_RUN,
        { sessionId, save: true }
      );
      setResult(evalResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测失败');
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    runEvaluation();
  }, [runEvaluation]);

  const handleExport = async (format: EvaluationExportFormat) => {
    if (!result || !window.electronAPI) return;
    setExporting(true);
    try {
      const content = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_EXPORT,
        { result, format }
      );

      const blob = new Blob([content], {
        type: format === 'json' ? 'application/json' : 'text/markdown',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `evaluation-${result.id}.${format === 'json' ? 'json' : 'md'}`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Export failed:', err);
    } finally {
      setExporting(false);
    }
  };

  const formatDuration = (ms: number): string => {
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    if (minutes > 0) {
      return `${minutes}m ${seconds % 60}s`;
    }
    return `${seconds}s`;
  };

  if (loading) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-8 text-center">
          <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full mx-auto mb-4" />
          <div className="text-gray-300">正在评测会话...</div>
          <div className="text-xs text-gray-500 mt-2">分析 6 个维度</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm">
        <div className="bg-zinc-900 rounded-xl border border-zinc-700 p-8 text-center max-w-md">
          <div className="text-red-400 text-4xl mb-4">⚠</div>
          <div className="text-gray-300 mb-2">评测失败</div>
          <div className="text-xs text-gray-500 mb-4">{error}</div>
          <div className="flex gap-2 justify-center">
            <button
              onClick={runEvaluation}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition"
            >
              重试
            </button>
            <button
              onClick={onClose}
              className="px-4 py-2 bg-zinc-700 text-gray-300 rounded-lg hover:bg-zinc-600 transition"
            >
              关闭
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!result) {
    return null;
  }

  const gradeColor = GRADE_COLORS[result.grade];
  const gradeBg = GRADE_BG_COLORS[result.grade];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
      <div className="bg-zinc-900 rounded-xl border border-zinc-700 w-full max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-zinc-700">
          <h2 className="text-lg font-semibold text-gray-200">会话评测</h2>
          <div className="flex items-center gap-2">
            <div className="relative group">
              <button
                className="px-3 py-1.5 text-sm bg-zinc-800 text-gray-300 rounded-lg hover:bg-zinc-700 transition flex items-center gap-1"
                disabled={exporting}
              >
                {exporting ? '导出中...' : '导出'}
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </button>
              <div className="absolute right-0 top-full mt-1 hidden group-hover:block bg-zinc-800 rounded-lg shadow-lg border border-zinc-700 overflow-hidden z-10">
                <button
                  onClick={() => handleExport('markdown')}
                  className="block w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-zinc-700"
                >
                  Markdown
                </button>
                <button
                  onClick={() => handleExport('json')}
                  className="block w-full px-4 py-2 text-left text-sm text-gray-300 hover:bg-zinc-700"
                >
                  JSON
                </button>
              </div>
            </div>
            <button
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-200 hover:bg-zinc-800 rounded-lg transition"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          <div className="flex flex-col md:flex-row gap-4">
            <div className="flex-1 bg-zinc-800/50 rounded-lg p-4 flex items-center gap-6">
              <div className="text-center">
                <div className="text-5xl font-bold text-white mb-1">
                  {result.overallScore}
                </div>
                <div
                  className={`inline-block ${gradeColor} ${gradeBg} px-3 py-1 rounded-full text-lg font-bold`}
                >
                  {result.grade}
                </div>
              </div>
              <div className="flex-1 text-sm text-gray-400">
                <div className="mb-2">
                  评测时间: {new Date(result.timestamp).toLocaleString()}
                </div>
                <div>
                  会话 ID: <span className="font-mono text-xs">{result.sessionId}</span>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-center p-2">
              <RadarChart metrics={result.metrics} size={200} />
            </div>
          </div>

          <div>
            <h3 className="text-sm font-medium text-gray-400 mb-3">详细指标</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              {result.metrics.map((metric) => (
                <MetricCard key={metric.dimension} metric={metric} />
              ))}
            </div>
          </div>

          {result.topSuggestions.length > 0 && (
            <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-4">
              <h3 className="text-sm font-medium text-yellow-400 mb-2 flex items-center gap-2">
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20">
                  <path
                    fillRule="evenodd"
                    d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
                改进建议
              </h3>
              <ul className="space-y-1">
                {result.topSuggestions.map((suggestion, i) => (
                  <li key={i} className="text-sm text-yellow-200/80">
                    • {suggestion}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="bg-zinc-800/30 rounded-lg p-4">
            <h3 className="text-sm font-medium text-gray-400 mb-3">统计摘要</h3>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-4 text-center">
              <div>
                <div className="text-xl font-semibold text-white">
                  {formatDuration(result.statistics.duration)}
                </div>
                <div className="text-xs text-gray-500">时长</div>
              </div>
              <div>
                <div className="text-xl font-semibold text-white">
                  {result.statistics.turnCount}
                </div>
                <div className="text-xs text-gray-500">轮次</div>
              </div>
              <div>
                <div className="text-xl font-semibold text-white">
                  {result.statistics.toolCallCount}
                </div>
                <div className="text-xs text-gray-500">工具调用</div>
              </div>
              <div>
                <div className="text-xl font-semibold text-white">
                  {(result.statistics.inputTokens + result.statistics.outputTokens).toLocaleString()}
                </div>
                <div className="text-xs text-gray-500">Token</div>
              </div>
              <div>
                <div className="text-xl font-semibold text-white">
                  ${result.statistics.totalCost.toFixed(4)}
                </div>
                <div className="text-xs text-gray-500">费用</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
