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

  it('D1：主 loop idle 但成员还在后台跑时，主位让给停止而不是通话', () => {
    expect(resolveLiveVoiceSlot({ ...BASE, hasStoppableBackgroundWork: true })).toBe('none');
  });
});

// ============================================================================
// D1 停止全部（2026-08-05）
// ============================================================================
// spawn_agent 超前台预算把成员转后台后，主 loop 本轮正常收尾、主会话回落 idle。
// 此前主操作只看 isProcessing，于是发送键立刻变回发送形态——停止入口消失，
// agentAppService.cancel 里现成的级联取消再也没人触发。
describe('D1：主 loop idle + swarm 成员在跑', () => {
  it('无草稿时主操作是停止（而不是发送）', () => {
    expect(resolveComposerCoreActions({
      ...BASE,
      isProcessing: false,
      hasStoppableBackgroundWork: true,
    })).toEqual(['voice-input', 'stop']);
  });

  it('有草稿时仍是发送——主 loop 空闲，新消息该正常发出去而不是排队', () => {
    expect(resolveComposerCoreActions({
      ...BASE,
      isProcessing: false,
      hasContent: true,
      hasStoppableBackgroundWork: true,
    })).toEqual(['voice-input', 'send']);
  });

  it('没有后台工作时不改变原行为（回归护栏）', () => {
    expect(resolveComposerCoreActions({
      ...BASE,
      isProcessing: false,
      hasStoppableBackgroundWork: false,
    })).toEqual(['voice-input', 'live-voice']);
    expect(resolveComposerCoreActions({
      ...BASE,
      hasMessages: true,
      isProcessing: false,
    })).toEqual(['voice-input', 'send']);
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
