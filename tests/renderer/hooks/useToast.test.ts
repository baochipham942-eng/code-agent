// useToast 的错误收敛（现象 11，渲染侧症状治理）：
// 同一条 finding 重复几十遍 → 折叠成 `×N`；正常消息原样通过。
import { beforeEach, describe, expect, it } from 'vitest';
import { dedupeRepeatedListItems, useToastStore } from '../../../src/renderer/hooks/useToast';

describe('dedupeRepeatedListItems', () => {
  it('相邻重复的 finding 折叠成 ×N（BRANCH_QUARANTINED 实形）', () => {
    const findings = Array(12).fill('PROJECTION_ALIAS_ORDER_MISMATCH').join(', ');
    const out = dedupeRepeatedListItems(
      `创建分支失败: BRANCH_QUARANTINED: branch cbranch_8a43 has unresolved lineage findings: ${findings}`,
    );
    expect(out).toBe(
      '创建分支失败: BRANCH_QUARANTINED: branch cbranch_8a43 has unresolved lineage findings: PROJECTION_ALIAS_ORDER_MISMATCH ×12',
    );
  });

  it('只有一段重复时只折那一段', () => {
    expect(dedupeRepeatedListItems('alpha, beta, beta, beta, gamma')).toBe('alpha, beta ×3, gamma');
  });

  it('没有相邻重复段的正常消息原样通过', () => {
    expect(dedupeRepeatedListItems('创建分支失败: 网络超时，请重试')).toBe('创建分支失败: 网络超时，请重试');
    expect(dedupeRepeatedListItems('a, b')).toBe('a, b');
  });

  it('多行各自折叠', () => {
    expect(dedupeRepeatedListItems('x, x\ny, y, y')).toBe('x ×2\ny ×3');
  });
});

describe('useToastStore.addToast', () => {
  beforeEach(() => {
    useToastStore.setState({ toasts: [] });
  });

  it('入库前先去重', () => {
    useToastStore.getState().addToast('error', 'e, e, e');
    expect(useToastStore.getState().toasts[0]?.message).toBe('e ×3');
  });
});
