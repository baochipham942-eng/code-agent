// ============================================================================
// composer 核心操作区产品门（2026-08-02 产品负责人改判）
// ============================================================================
// 核心操作区只指工具栏右端两个同级操作项：口述输入 + 主操作。
// 附件「+」、身份/连接器/权限/模型、审批与提示 chip、VoiceChrome 状态条不计入。
// 生产 JSX 逐项消费 resolveComposerCoreActions 的结果，因此未来新增同级核心按钮
// 必须先进入这个动作列表，并被状态矩阵的「≤2」门拦截。
// ============================================================================
import { describe, expect, it } from 'vitest';

import {
  COMPOSER_CORE_ACTION_LIMIT,
  resolveComposerCoreActions,
  resolveLiveVoiceSlot,
} from '../../../src/renderer/components/features/chat/ChatInput';

const BASE = {
  hasContent: false,
  isProcessing: false,
  sessionId: 'session-1' as string | null,
  enabled: true,
  phase: 'idle' as const,
  hasMessages: false,
  hadLiveVoice: false,
};

describe('resolveLiveVoiceSlot（composer 两项上限）', () => {
  it('空会话：空输入框 + 没在跑 + 入口可用 + idle → 主位', () => {
    expect(resolveLiveVoiceSlot(BASE)).toBe('primary');
  });

  it('纯文字会话：已有消息但从未实时通话 → 不渲染', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, hasMessages: true })).toBe('none');
  });

  it('语音会话：hadLiveVoice 为 true 的存量会话仍可拨', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, hasMessages: true, hadLiveVoice: true })).toBe('primary');
  });

  it('正在跑时不渲染通话按钮，停止/排队发送独占主位', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, isProcessing: true })).toBe('none');
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

describe('composer 核心操作区状态矩阵', () => {
  it('固定产品上限为 2，且所有状态渲染出的同级操作项恒不超过上限', () => {
    expect(COMPOSER_CORE_ACTION_LIMIT).toBe(2);

    const sessions = [
      { name: '空会话', hasMessages: false, hadLiveVoice: false },
      { name: '文字会话', hasMessages: true, hadLiveVoice: false },
      { name: '语音会话', hasMessages: true, hadLiveVoice: true },
    ];
    const inputs = [
      { name: '输入框空', hasContent: false },
      { name: '输入框有内容', hasContent: true },
    ];
    const runs = [
      { name: 'idle', isProcessing: false },
      { name: 'running', isProcessing: true },
    ];
    const callPhases = [
      { name: '通话 idle', phase: 'idle' as const },
      { name: '通话非 idle', phase: 'live' as const },
    ];

    for (const session of sessions) {
      for (const input of inputs) {
        for (const run of runs) {
          for (const call of callPhases) {
            const state = { ...BASE, ...session, ...input, ...run, ...call };
            const actions = resolveComposerCoreActions(state);
            const label = `${session.name} / ${input.name} / ${run.name} / ${call.name}`;
            const shouldShowLiveVoice = call.phase === 'idle'
              && !run.isProcessing
              && !input.hasContent
              && (!session.hasMessages || session.hadLiveVoice);
            const expectedPrimary = shouldShowLiveVoice
              ? 'live-voice'
              : run.isProcessing && !input.hasContent
                ? 'stop'
                : 'send';

            expect(actions.length, label).toBeLessThanOrEqual(COMPOSER_CORE_ACTION_LIMIT);
            expect(actions, label).toEqual(['voice-input', expectedPrimary]);
          }
        }
      }
    }
  });
});
