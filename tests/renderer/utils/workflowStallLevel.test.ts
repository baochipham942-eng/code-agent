import { describe, expect, it } from 'vitest';
import type { ScriptRunSnapshot } from '../../../src/shared/contract/scriptRun';
import { deriveWorkflowStallLevel } from '../../../src/renderer/utils/workflowStallLevel';
import { WORKFLOW_STALL_THRESHOLDS } from '../../../src/shared/constants';

const T0 = 1_000_000;

function snap(over: Partial<ScriptRunSnapshot> = {}): ScriptRunSnapshot {
  return {
    runId: 'wf-1',
    status: 'running',
    phases: [],
    logs: [],
    agents: [],
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    startedAt: T0,
    lastActivityAt: T0,
    ...over,
  };
}

describe('deriveWorkflowStallLevel 阈值（N-WF-STALL-UI）', () => {
  it('阈值边界：idle 恰好等于 N_SOFT/N_HARD 不报（严格大于），+1ms 才报', () => {
    expect(deriveWorkflowStallLevel(snap(), T0 + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS)).toBe('none');
    expect(deriveWorkflowStallLevel(snap(), T0 + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 1)).toBe('quiet');
    expect(deriveWorkflowStallLevel(snap({ stallNoticeEpoch: 1 }), T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS)).toBe('quiet');
    expect(deriveWorkflowStallLevel(snap({ stallNoticeEpoch: 1 }), T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS + 1)).toBe('long');
  });

  it('超过硬阈值但宿主还没公告（epoch 缺省）仍是 quiet——「已提醒 Neo」不许说谎', () => {
    // in-flight agent call 档：检测器等 SINGLE_CALL_MS(30min)，中间空档只有软提示。
    expect(deriveWorkflowStallLevel(snap(), T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2)).toBe('quiet');
  });

  it('epoch>=1 但 idle 回到软阈值区间 → quiet（新进展后降级，不说已提醒）', () => {
    expect(deriveWorkflowStallLevel(snap({ stallNoticeEpoch: 2 }), T0 + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 1)).toBe('quiet');
  });
});

describe('deriveWorkflowStallLevel 不报场景', () => {
  it('非 running 状态（pending/completed/failed/cancelled）一律 none', () => {
    for (const status of ['pending', 'completed', 'failed', 'cancelled'] as const) {
      expect(deriveWorkflowStallLevel(snap({ status }), T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2)).toBe('none');
    }
  });

  it('parked（等审批/审查）不报停顿', () => {
    expect(deriveWorkflowStallLevel(snap({ parked: true }), T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2)).toBe('none');
  });

  it('锚点回退：无 lastActivityAt 时用 startedAt；两者都缺 fail-closed 不误报', () => {
    const { lastActivityAt: _drop, ...noActivity } = snap();
    expect(deriveWorkflowStallLevel(noActivity, T0 + WORKFLOW_STALL_THRESHOLDS.N_SOFT_MS + 1)).toBe('quiet');
    const { lastActivityAt: _d2, startedAt: _d3, ...bare } = snap();
    expect(deriveWorkflowStallLevel(bare, T0 + WORKFLOW_STALL_THRESHOLDS.N_HARD_MS * 2)).toBe('none');
  });

  it('时钟早于锚点（负 idle）不报', () => {
    expect(deriveWorkflowStallLevel(snap(), T0 - 5000)).toBe('none');
  });
});
