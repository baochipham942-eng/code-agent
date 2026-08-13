// ============================================================================
// modeStore.test.ts - 应用模式状态（含逐轮联网搜索开关）
// ============================================================================

// @vitest-environment jsdom
// jsdom 提供 localStorage，zustand persist 才会挂 .persist API（node 环境下没有）。

import { describe, it, expect } from 'vitest';

import { useModeStore } from '../../../src/renderer/stores/modeStore';

describe('modeStore searchEnabled（逐轮联网搜索开关）', () => {
  it('defaults searchEnabled to true', () => {
    expect(useModeStore.getState().searchEnabled).toBe(true);
  });

  it('setWebSearchEnabled only updates the persisted local state', () => {
    useModeStore.getState().setWebSearchEnabled(false);
    expect(useModeStore.getState().searchEnabled).toBe(false);
    useModeStore.getState().setWebSearchEnabled(true);
    expect(useModeStore.getState().searchEnabled).toBe(true);
  });

  it('migrates legacy persisted state without searchEnabled to true', () => {
    const migrate = useModeStore.persist.getOptions().migrate;
    const migrated = migrate?.(
      { mode: 'cowork', effortLevel: 'high', thinkingEnabled: false },
      5,
    ) as { searchEnabled?: boolean; thinkingEnabled?: boolean };
    expect(migrated.searchEnabled).toBe(true);
    // 既有字段不被 migrate 覆盖
    expect(migrated.thinkingEnabled).toBe(false);
  });

  it('keeps an explicitly persisted searchEnabled value across migrate', () => {
    const migrate = useModeStore.persist.getOptions().migrate;
    const migrated = migrate?.(
      { mode: 'cowork', effortLevel: 'high', thinkingEnabled: true, searchEnabled: false },
      6,
    ) as { searchEnabled?: boolean };
    expect(migrated.searchEnabled).toBe(false);
  });
});
