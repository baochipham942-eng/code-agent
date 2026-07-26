// voiceCallStore 七态推导与事件应用（方案 §7.3）。
import { beforeEach, describe, expect, it } from 'vitest';
import {
  selectVoiceVisualState,
  useVoiceCallStore,
} from '../../../src/renderer/stores/voiceCallStore';

const base = {
  phase: 'live' as const,
  muted: false,
  assistantSpeaking: false,
  workItems: [],
};

describe('selectVoiceVisualState 七态', () => {
  it('idle / connecting / error 直接由相位映射', () => {
    expect(selectVoiceVisualState({ ...base, phase: 'idle' })).toBe('idle');
    expect(selectVoiceVisualState({ ...base, phase: 'connecting' })).toBe('connecting');
    expect(selectVoiceVisualState({ ...base, phase: 'error' })).toBe('error');
  });

  it('live 默认 listening；assistantSpeaking → speaking', () => {
    expect(selectVoiceVisualState(base)).toBe('listening');
    expect(selectVoiceVisualState({ ...base, assistantSpeaking: true })).toBe('speaking');
  });

  it('有排队中的任务 → working；优先级低于 muted、高于 speaking', () => {
    const workItems = [{ id: 'w1', title: '写测例', status: 'queued' as const }];
    expect(selectVoiceVisualState({ ...base, workItems })).toBe('working');
    expect(selectVoiceVisualState({ ...base, workItems, assistantSpeaking: true })).toBe('working');
    expect(selectVoiceVisualState({ ...base, workItems, muted: true })).toBe('muted');
  });

  it('muted 盖住 listening/speaking，但盖不住 error', () => {
    expect(selectVoiceVisualState({ ...base, muted: true })).toBe('muted');
    expect(selectVoiceVisualState({ ...base, muted: true, phase: 'error' })).toBe('error');
  });
});

describe('voiceCallStore 动作', () => {
  beforeEach(() => {
    useVoiceCallStore.getState().reset();
  });

  it('dialStarted 清空上一通残留并进 connecting', () => {
    const store = useVoiceCallStore.getState();
    store.eventApplied({ partialAssistant: '上一通的字幕', workItem: { id: 'w0', title: '旧活', status: 'queued' } });
    store.dialStarted('s1', 'role-a', 'push_to_talk');

    const state = useVoiceCallStore.getState();
    expect(state.phase).toBe('connecting');
    expect(state.sessionId).toBe('s1');
    expect(state.activeAgentId).toBe('role-a');
    expect(state.interruptMode).toBe('push_to_talk');
    expect(state.partialAssistant).toBe('');
    expect(state.workItems).toEqual([]);
  });

  it('work.upsert 按 id 去重更新（同一件活重发不重复计）', () => {
    const store = useVoiceCallStore.getState();
    store.dialStarted('s1', undefined, 'server_vad');
    store.eventApplied({ workItem: { id: 'w1', title: '写测例', status: 'queued' } });
    store.eventApplied({ workItem: { id: 'w1', title: '写测例', status: 'failed', detail: 'boom' } });

    const { workItems } = useVoiceCallStore.getState();
    expect(workItems).toHaveLength(1);
    expect(workItems[0].status).toBe('failed');
  });

  it('reset 回到 idle 初始态', () => {
    const store = useVoiceCallStore.getState();
    store.dialStarted('s1', 'role-a', 'server_vad');
    store.muteChanged(true);
    store.reset();

    const state = useVoiceCallStore.getState();
    expect(state.phase).toBe('idle');
    expect(state.sessionId).toBeNull();
    expect(state.muted).toBe(false);
    expect(selectVoiceVisualState(state)).toBe('idle');
  });
});
