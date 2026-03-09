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
}

/**
 * 将 failureReason / errors 映射到漏斗阶段
 *
 * 阶段顺序（从左到右，流程图）：
 * 1. 总用例
 * 2. 通过安全检查（排除 forbidden pattern 失败）
 * 3. 执行成功（排除 timeout / execution error）
 * 4. 输出符合预期（排除 assertion / tool-not-called 失败）
 * 5. LLM 评分通过（排除 partial/low score）
 */
/**
 * Map persisted failureStage (from pipeline or experimentAdapter) to local stage name.
 * Returns undefined if the value is not recognized (triggers fallback).
 */
const STAGE_MAP: Record<string, 'security' | 'execution' | 'assertion' | 'llm_score'> = {
  security_guard: 'security',
  security: 'security',
  compilation_check: 'execution',
  compilation: 'execution',
  self_repair_check: 'execution',
  self_repair: 'execution',
  outcome_verification: 'assertion',
  verification: 'assertion',
  llm_scoring: 'llm_score',
};

function classifyCase(r: TestCaseResult): 'security' | 'execution' | 'assertion' | 'llm_score' | 'pass' {
  if (r.status === 'passed') return 'pass';

  // Prefer persisted failureStage from pipeline (if available)
  if (r.failureStage) {
    const mapped = STAGE_MAP[r.failureStage];
    if (mapped) return mapped;
  }

  // Fallback: string-matching heuristics (for legacy data without failureStage)
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

/** Color classes based on retention rate */
function getNodeColors(retentionRate: number): {
  border: string;
  bg: string;
  text: string;
  countText: string;
} {
  if (retentionRate >= 0.9) {
    return {
      border: 'border-emerald-500/60',
      bg: 'bg-emerald-500/10',
      text: 'text-emerald-400',
      countText: 'text-emerald-300',
    };
  }
  if (retentionRate >= 0.7) {
    return {
      border: 'border-amber-500/60',
      bg: 'bg-amber-500/10',
      text: 'text-amber-400',
      countText: 'text-amber-300',
    };
  }
  return {
    border: 'border-red-500/60',
    bg: 'bg-red-500/10',
    text: 'text-red-400',
    countText: 'text-red-300',
  };
}

/** SVG arrow connector between nodes */
const ArrowConnector: React.FC<{ hasDrop: boolean }> = ({ hasDrop }) => (
  <div className="flex flex-col items-center justify-start pt-5 shrink-0 mx-0.5" style={{ width: 32 }}>
    <svg width="32" height="16" viewBox="0 0 32 16" className="shrink-0">
      <line
        x1="0" y1="8" x2="24" y2="8"
        stroke={hasDrop ? '#f87171' : '#52525b'}
        strokeWidth="1.5"
        strokeDasharray={hasDrop ? '4 2' : undefined}
      />
      <polygon
        points="22,3.5 32,8 22,12.5"
        fill={hasDrop ? '#f87171' : '#52525b'}
      />
    </svg>
  </div>
);

/** Drop indicator card below the arrow */
const DropIndicator: React.FC<{ dropped: number; dropRate: number }> = ({ dropped, dropRate }) => {
  if (dropped === 0) return null;
  return (
    <div className="mt-1.5 flex flex-col items-center whitespace-nowrap">
      <svg width="8" height="6" viewBox="0 0 8 6" className="text-red-400/60 mb-0.5">
        <polygon points="4,6 0,0 8,0" fill="currentColor" />
      </svg>
      <span className="text-[10px] bg-red-500/10 border border-red-500/30 rounded px-1.5 py-0.5 text-red-400 tabular-nums">
        -{dropped} ({dropRate.toFixed(0)}%)
      </span>
    </div>
  );
};

/** Stage node in the flow diagram */
const StageNode: React.FC<{
  stage: FunnelStage;
  totalCount: number;
  isFirst: boolean;
}> = ({ stage, totalCount, isFirst }) => {
  const retentionRate = totalCount > 0 ? stage.count / totalCount : 1;
  const colors = isFirst
    ? { border: 'border-border-strong/60', bg: 'bg-hover', text: 'text-text-secondary', countText: 'text-text-primary' }
    : getNodeColors(retentionRate);

  return (
    <div className="shrink-0 flex flex-col items-center" style={{ minWidth: 100 }}>
      <div
        className={`${colors.bg} ${colors.border} border rounded-lg px-2.5 py-2.5 flex flex-col items-center text-center w-full`}
      >
        <span className={`text-[11px] font-semibold ${colors.text} leading-tight`}>
          {stage.label}
        </span>
        <span className={`text-lg font-bold tabular-nums mt-1 ${colors.countText}`}>
          {stage.count}
        </span>
        <span className="text-[9px] text-text-tertiary mt-0.5 leading-tight">
          {stage.sublabel}
        </span>
      </div>
      {!isFirst && <DropIndicator dropped={stage.dropped} dropRate={stage.dropRate} />}
    </div>
  );
};

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
      },
      {
        label: '安全检查',
        sublabel: '禁止模式',
        count: total - security_fail.length,
        dropped: security_fail.length,
        dropRate: total > 0 ? (security_fail.length / total) * 100 : 0,
      },
      {
        label: '执行成功',
        sublabel: '超时/运行时',
        count: total - security_fail.length - execution_fail.length,
        dropped: execution_fail.length,
        dropRate: total > 0 ? (execution_fail.length / total) * 100 : 0,
      },
      {
        label: '输出验证',
        sublabel: '工具/断言',
        count: total - security_fail.length - execution_fail.length - assertion_fail.length,
        dropped: assertion_fail.length,
        dropRate: total > 0 ? (assertion_fail.length / total) * 100 : 0,
      },
      {
        label: 'LLM评分',
        sublabel: '部分通过 / 低分',
        count: total - security_fail.length - execution_fail.length - assertion_fail.length - llm_fail.length,
        dropped: llm_fail.length,
        dropRate: total > 0 ? (llm_fail.length / total) * 100 : 0,
      },
    ];
  }, [cases]);

  if (cases.length === 0) {
    return (
      <div className="flex items-center justify-center py-6 text-text-tertiary text-xs">
        暂无数据
      </div>
    );
  }

  const total = cases.length;

  return (
    <div className="bg-surface border border-border-default/20 rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-border-default/20">
        <span className="text-xs font-medium text-text-secondary">失败漏斗</span>
        <span className="text-[10px] text-text-tertiary ml-2">{total} 用例 · 流程图</span>
      </div>

      <div className="p-4 overflow-x-auto">
        <div className="flex items-start gap-0">
          {stages.map((stage, idx) => (
            <React.Fragment key={stage.label}>
              <StageNode stage={stage} totalCount={total} isFirst={idx === 0} />
              {idx < stages.length - 1 && (
                <ArrowConnector hasDrop={stages[idx + 1].dropped > 0} />
              )}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
};
