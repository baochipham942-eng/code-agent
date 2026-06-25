// ADR-027 slice5：自主信封 store 行为（pendingRequest / grant 重置变体组 / clear）。
import { describe, it, expect, beforeEach } from 'vitest';
import { useDesignAutonomyStore } from '@renderer/components/design/designAutonomyStore';
import { consume } from '@shared/contract/designAutonomy';
import type { AutonomyEnvelopeRequest } from '@shared/contract';

const req: AutonomyEnvelopeRequest = { requestId: 'da-1', goal: '探索方向', proposed: { maxVariants: 3 } };

beforeEach(() => {
  useDesignAutonomyStore.setState({ pendingRequest: null, envelope: null, variantGroupId: null });
});

describe('designAutonomyStore', () => {
  it('setPendingRequest / 清除', () => {
    useDesignAutonomyStore.getState().setPendingRequest(req);
    expect(useDesignAutonomyStore.getState().pendingRequest).toBe(req);
    useDesignAutonomyStore.getState().setPendingRequest(null);
    expect(useDesignAutonomyStore.getState().pendingRequest).toBeNull();
  });

  it('grantFromApproval 建立信封并重置变体组；绑 sessionId + 快照单价（R2-MED-1）', () => {
    useDesignAutonomyStore.setState({ variantGroupId: 'stale-group' });
    const env = useDesignAutonomyStore.getState().grantFromApproval({ maxVariants: 3, maxCny: 0.5 }, 'sess-9', 3.0);
    expect(env.maxVariants).toBe(3);
    expect(useDesignAutonomyStore.getState().envelope).toEqual(env);
    expect(useDesignAutonomyStore.getState().envelopeSessionId).toBe('sess-9');
    expect(useDesignAutonomyStore.getState().perImageCny).toBe(3.0); // 快照真实单价供预算闸兜底
    expect(useDesignAutonomyStore.getState().variantGroupId).toBeNull(); // 新一轮重置
  });

  it('clear 连带清 perImageCny 快照', () => {
    useDesignAutonomyStore.getState().grantFromApproval({ maxVariants: 2 }, 'sess-1', 3.0);
    useDesignAutonomyStore.getState().clear();
    expect(useDesignAutonomyStore.getState().perImageCny).toBeNull();
    expect(useDesignAutonomyStore.getState().envelopeSessionId).toBeNull();
  });

  it('setEnvelope 持久消费；setVariantGroupId 记录组', () => {
    const env = useDesignAutonomyStore.getState().grantFromApproval({ maxVariants: 3, maxCny: 1 });
    useDesignAutonomyStore.getState().setEnvelope(consume(env, { landed: true, costCny: 0.14 }));
    expect(useDesignAutonomyStore.getState().envelope!.usedVariants).toBe(1);
    useDesignAutonomyStore.getState().setVariantGroupId('node-1');
    expect(useDesignAutonomyStore.getState().variantGroupId).toBe('node-1');
  });

  it('clear 作废信封 + 变体组（不动 pendingRequest）', () => {
    useDesignAutonomyStore.setState({ pendingRequest: req });
    useDesignAutonomyStore.getState().grantFromApproval({ maxVariants: 2 });
    useDesignAutonomyStore.getState().setVariantGroupId('g');
    useDesignAutonomyStore.getState().clear();
    expect(useDesignAutonomyStore.getState().envelope).toBeNull();
    expect(useDesignAutonomyStore.getState().variantGroupId).toBeNull();
    expect(useDesignAutonomyStore.getState().pendingRequest).toBe(req); // clear 不动审批请求
  });
});
