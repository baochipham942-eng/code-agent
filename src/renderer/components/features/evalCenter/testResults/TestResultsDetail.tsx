import React, { useState } from 'react';
import type { TestCaseResult } from '@shared/ipc';

interface Props {
  result: TestCaseResult;
}

export const TestResultsDetail: React.FC<Props> = ({ result }) => {
  const [activeTab, setActiveTab] = useState<'expectations' | 'tools' | 'responses'>('expectations');

  const tabs = [
    { key: 'expectations' as const, label: '断言', count: result.expectationResults?.length || 0 },
    { key: 'tools' as const, label: '工具调用', count: result.toolExecutions?.length || 0 },
    { key: 'responses' as const, label: '响应', count: result.responses?.length || 0 },
  ];

  return (
    <div className="bg-zinc-900/50 border-t border-zinc-700/20 p-3">
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
                ? 'bg-zinc-700 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-800'
            }`}
          >
            {tab.label} ({tab.count})
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
                  <div className="text-zinc-300">
                    <span className="font-mono text-zinc-500">[{er.expectation.type}]</span>{' '}
                    {er.expectation.description}
                    {er.expectation.critical && (
                      <span className="ml-1 text-[10px] text-red-400 font-medium">CRITICAL</span>
                    )}
                  </div>
                  <div className="text-zinc-500 mt-0.5">
                    期望: {er.evidence.expected} · 实际: {er.evidence.actual}
                  </div>
                </div>
                {er.expectation.weight !== 1 && (
                  <span className="text-[10px] text-zinc-600 flex-shrink-0">w={er.expectation.weight}</span>
                )}
              </div>
            ))
          ) : (
            <div className="text-zinc-600 text-[11px]">无断言结果</div>
          )}
        </div>
      )}

      {/* Tools tab */}
      {activeTab === 'tools' && (
        <div className="space-y-1.5">
          {result.toolExecutions?.length ? (
            result.toolExecutions.map((te, i) => (
              <div key={i} className="p-2 bg-zinc-800/50 border border-zinc-700/20 rounded text-[11px]">
                <div className="flex items-center gap-2">
                  <span className={`font-mono font-medium ${te.success ? 'text-emerald-400' : 'text-red-400'}`}>
                    {te.tool}
                  </span>
                  <span className="text-zinc-600">{te.duration}ms</span>
                </div>
                {te.input && (
                  <pre className="mt-1 text-zinc-500 overflow-x-auto max-h-20 text-[10px]">
                    {typeof te.input === 'string' ? te.input : JSON.stringify(te.input, null, 2)}
                  </pre>
                )}
                {te.output && (
                  <pre className="mt-1 text-zinc-400 overflow-x-auto max-h-20 text-[10px] whitespace-pre-wrap">
                    {typeof te.output === 'string' ? te.output.slice(0, 500) : JSON.stringify(te.output).slice(0, 500)}
                    {(typeof te.output === 'string' ? te.output.length : JSON.stringify(te.output).length) > 500 && '...'}
                  </pre>
                )}
              </div>
            ))
          ) : (
            <div className="text-zinc-600 text-[11px]">无工具调用</div>
          )}
        </div>
      )}

      {/* Responses tab */}
      {activeTab === 'responses' && (
        <div className="space-y-1.5">
          {result.responses?.length ? (
            result.responses.map((resp, i) => (
              <div key={i} className="p-2 bg-zinc-800/50 border border-zinc-700/20 rounded text-[11px] text-zinc-300 whitespace-pre-wrap max-h-32 overflow-y-auto">
                {resp}
              </div>
            ))
          ) : (
            <div className="text-zinc-600 text-[11px]">无响应</div>
          )}
        </div>
      )}

      {/* Reference solution */}
      {result.reference_solution && (
        <div className="mt-3 p-2 bg-blue-500/5 border border-blue-500/10 rounded text-[11px]">
          <span className="text-blue-400 font-medium">参考方案:</span>{' '}
          <span className="text-zinc-400">{result.reference_solution}</span>
        </div>
      )}
    </div>
  );
};
