import React, { useMemo } from 'react';
import type { TestCaseResult } from '@shared/ipc';

interface Props {
  cases: TestCaseResult[];
}

interface FunnelStage {
  label: string;
  sublabel: string;
  count: number;
  dropped: number;
  dropRate: number;
  color: string;
  bgColor: string;
}

/**
 * 将 failureReason / errors 映射到漏斗阶段
 *
 * 阶段顺序（从上到下）：
 * 1. 总用例
 * 2. 通过安全检查（排除 forbidden pattern 失败）
 * 3. 执行成功（排除 timeout / execution error）
 * 4. 输出符合预期（排除 assertion / tool-not-called 失败）
 * 5. LLM 评分通过（排除 partial/low score）
 */
function classifyCase(r: TestCaseResult): 'security' | 'execution' | 'assertion' | 'llm_score' | 'pass' {
  if (r.status === 'passed') return 'pass';

  const reason = (r.failureReason ?? '').toLowerCase();
  const errText = r.errors.join(' ').toLowerCase();
  const combined = reason + ' ' + errText;

  // Security / forbidden pattern
  if (
    combined.includes('forbidden') ||
    combined.includes('security') ||
    combined.includes('blocked')
  ) {
    return 'security';
  }

  // Execution errors (timeout, crash)
  if (
    combined.includes('timeout') ||
    combined.includes('execution error') ||
    combined.includes('runtime error') ||
    combined.includes('exception')
  ) {
    return 'execution';
  }

  // Assertion / tool not called / output mismatch
  if (
    combined.includes('expected tool') ||
    combined.includes('assertion') ||
    combined.includes('output') ||
    combined.includes('tool') ||
    combined.includes('expected')
  ) {
    return 'assertion';
  }

  // Partial pass = LLM score too low
  if (r.status === 'partial') {
    return 'llm_score';
  }

  // Default: treat as assertion failure
  return 'assertion';
}

export const FailureFunnel: React.FC<Props> = ({ cases }) => {
  const stages = useMemo<FunnelStage[]>(() => {
    const total = cases.length;
    if (total === 0) return [];

    let remaining = cases;

    const security_fail = remaining.filter((r) => classifyCase(r) === 'security');
    remaining = remaining.filter((r) => classifyCase(r) !== 'security');

    const execution_fail = remaining.filter((r) => classifyCase(r) === 'execution');
    remaining = remaining.filter((r) => classifyCase(r) !== 'execution');

    const assertion_fail = remaining.filter((r) => classifyCase(r) === 'assertion');
    remaining = remaining.filter((r) => classifyCase(r) !== 'assertion');

    const llm_fail = remaining.filter((r) => classifyCase(r) === 'llm_score');

    return [
      {
        label: '全部用例',
        sublabel: '测试集入口',
        count: total,
        dropped: 0,
        dropRate: 0,
        color: 'text-zinc-300',
        bgColor: 'bg-zinc-700/40',
      },
      {
        label: '通过安全检查',
        sublabel: 'Forbidden Patterns',
        count: total - security_fail.length,
        dropped: security_fail.length,
        dropRate: total > 0 ? (security_fail.length / total) * 100 : 0,
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10',
      },
      {
        label: '执行成功',
        sublabel: 'Timeout / Runtime Error',
        count: total - security_fail.length - execution_fail.length,
        dropped: execution_fail.length,
        dropRate: total > 0 ? (execution_fail.length / total) * 100 : 0,
        color: 'text-violet-400',
        bgColor: 'bg-violet-500/10',
      },
      {
        label: '输出符合预期',
        sublabel: 'Tool / Assertion Fail',
        count: total - security_fail.length - execution_fail.length - assertion_fail.length,
        dropped: assertion_fail.length,
        dropRate: total > 0 ? (assertion_fail.length / total) * 100 : 0,
        color: 'text-amber-400',
        bgColor: 'bg-amber-500/10',
      },
      {
        label: 'LLM 评分通过',
        sublabel: '部分通过 / 低分',
        count: total - security_fail.length - execution_fail.length - assertion_fail.length - llm_fail.length,
        dropped: llm_fail.length,
        dropRate: total > 0 ? (llm_fail.length / total) * 100 : 0,
        color: 'text-emerald-400',
        bgColor: 'bg-emerald-500/10',
      },
    ];
  }, [cases]);

  if (cases.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-zinc-500 text-xs">
        暂无数据
      </div>
    );
  }

  const total = cases.length;
  const maxCount = total;

  return (
    <div className="bg-zinc-800/40 border border-zinc-700/20 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-zinc-700/20">
        <span className="text-xs font-medium text-zinc-300">失败漏斗</span>
        <span className="text-[10px] text-zinc-500 ml-2">{total} 用例</span>
      </div>

      <div className="p-3 space-y-1.5">
        {stages.map((stage, idx) => {
          const widthPct = maxCount > 0 ? (stage.count / maxCount) * 100 : 0;
          const isLast = idx === stages.length - 1;

          return (
            <div key={stage.label}>
              {/* Funnel bar */}
              <div
                className={`${stage.bgColor} rounded-md px-3 py-2 transition-all`}
                style={{ marginLeft: `${idx * 2}%`, marginRight: `${idx * 2}%` }}
              >
                <div className="flex items-center justify-between mb-1">
                  <div>
                    <span className={`text-xs font-medium ${stage.color}`}>{stage.label}</span>
                    <span className="text-[10px] text-zinc-500 ml-2">{stage.sublabel}</span>
                  </div>
                  <span className={`text-sm font-bold tabular-nums ${stage.color}`}>
                    {stage.count}
                  </span>
                </div>

                {/* Width indicator bar */}
                <div className="w-full h-1 bg-zinc-700/50 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      isLast ? 'bg-emerald-500' : stage.bgColor.replace('/10', '/60')
                    }`}
                    style={{ width: `${widthPct}%` }}
                  />
                </div>
              </div>

              {/* Drop arrow between stages */}
              {!isLast && stage.dropped > 0 && (
                <div className="flex items-center gap-1.5 py-0.5 pl-4">
                  <svg className="w-2.5 h-2.5 text-red-400/60" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 16l-6-6h12z" />
                  </svg>
                  <span className="text-[10px] text-red-400/70">
                    流失 {stage.dropped} ({stage.dropRate.toFixed(0)}%)
                  </span>
                </div>
              )}
              {!isLast && stage.dropped === 0 && (
                <div className="h-2" />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
};
