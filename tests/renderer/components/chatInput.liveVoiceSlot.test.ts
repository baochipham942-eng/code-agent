// ============================================================================
// 实时通话入口槽位（X5.5 返工批 R4c）
// ============================================================================
// 真机：一通挂断后 composer 右下角通话按钮「短暂消失、下一通前又回来」。
// 根因：挂断瞬间 phase 同步回 idle（teardown 各路径都查过，无中间态），但派
// 出去的活还在跑 → isProcessing 把主按钮位判给停止键 → 通话按钮跟着消失，
// 活跑完才回来。修法：正在跑时通话入口退停止键左边的 ghost 次位，照常可拨。
//
// 承重条：teardown 后（phase 回 idle）按钮必须在——不管活跑没跑完。
// ============================================================================
import { describe, expect, it } from 'vitest';

import { resolveLiveVoiceSlot } from '../../../src/renderer/components/features/chat/ChatInput';

const BASE = {
  hasContent: false,
  isProcessing: false,
  sessionId: 'session-1' as string | null,
  enabled: true,
  phase: 'idle' as const,
};

describe('resolveLiveVoiceSlot（R4c）', () => {
  it('空输入框 + 没在跑 + 入口可用 + idle → 主位', () => {
    expect(resolveLiveVoiceSlot(BASE)).toBe('primary');
  });

  it('teardown 后按钮在：挂断回 idle、派出去的活还在跑 → 次位（停止键占主位，通话入口不消失）', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, isProcessing: true })).toBe('secondary');
  });

  it('正在跑 + 有草稿 → none（发送键有事可做，不再多占一格）', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, isProcessing: true, hasContent: true })).toBe('none');
  });

  it('通话中 / 建连中（VoiceChrome 接管底栏）→ none', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, phase: 'live' })).toBe('none');
    expect(resolveLiveVoiceSlot({ ...BASE, phase: 'connecting' })).toBe('none');
    expect(resolveLiveVoiceSlot({ ...BASE, phase: 'error' })).toBe('none');
  });

  it('总开关关 / 无会话 → none', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, enabled: false })).toBe('none');
    expect(resolveLiveVoiceSlot({ ...BASE, sessionId: null })).toBe('none');
  });
});
