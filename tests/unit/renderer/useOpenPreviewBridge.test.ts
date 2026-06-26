// 审计 M2 回归：WORKSPACE_OPEN_PREVIEW 会话闸 fail-closed。
import { describe, it, expect } from 'vitest';
import { shouldOpenPreview } from '../../../src/renderer/hooks/useOpenPreviewBridge';

describe('shouldOpenPreview（预览打开会话闸 fail-closed）', () => {
  it('无 sessionId → 允许（无前台会话可保护）', () => {
    expect(shouldOpenPreview(undefined, 'sess-1')).toBe(true);
    expect(shouldOpenPreview(undefined, null)).toBe(true);
  });
  it('sessionId 等于当前会话 → 允许', () => {
    expect(shouldOpenPreview('sess-1', 'sess-1')).toBe(true);
  });
  it('sessionId 不同于当前会话 → 不开', () => {
    expect(shouldOpenPreview('sess-1', 'sess-2')).toBe(false);
  });
  it('带 sessionId 但当前会话为空 → 不开（fail-closed，背景会话不抢焦点）', () => {
    expect(shouldOpenPreview('sess-1', null)).toBe(false);
    expect(shouldOpenPreview('sess-1', undefined)).toBe(false);
  });
});
