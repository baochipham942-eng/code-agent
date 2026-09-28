import { describe, expect, it } from 'vitest';
import { settleModelOpsForManualContinue } from '../../../../src/host/runtime/recoveredWaitingRun';
import type { PendingOperation } from '../../../../src/shared/contract/durableRun';

function op(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    runId: 'run-1', operationId: 'op', attempt: 3, kind: 'model_call', status: 'dispatched',
    idempotencyKey: 'k', sideEffect: false, preparedAt: 1, updatedAt: 1, ...overrides,
  };
}

// 槽 3 真机实付：第 3 次崩溃预算耗尽停靠时在途模型调用停在 dispatched，手动「继续」不收口
// ⇒ 这轮结束 completed 被「completed runs cannot contain unresolved operations」拒写。
describe('settleModelOpsForManualContinue', () => {
  it('abandons unresolved model calls so the continued run can reach a terminal state', () => {
    const settled = settleModelOpsForManualContinue([
      op({ operationId: 'model:dispatched', status: 'dispatched' }),
      op({ operationId: 'model:prepared', status: 'prepared' }),
      op({ operationId: 'model:unknown', status: 'unknown' }),
      op({ operationId: 'model:done', status: 'succeeded', resultRef: 'r' }),
    ], 42);
    expect(settled.map((o) => [o.operationId, o.status])).toEqual([
      ['model:dispatched', 'abandoned'],
      ['model:prepared', 'abandoned'],
      ['model:unknown', 'abandoned'],
      ['model:done', 'succeeded'],
    ]);
    expect(settled[0]).toMatchObject({ resultRef: 'model-recovery:superseded-by-manual-continue:model:dispatched', updatedAt: 42 });
  });

  it('leaves tool operations untouched (unknown writes are never silently settled)', () => {
    const tool = op({ operationId: 'tool:bash', kind: 'tool_call', status: 'unknown', sideEffect: true });
    expect(settleModelOpsForManualContinue([tool], 42)).toEqual([tool]);
  });
});
