import { describe, expect, it } from 'vitest';
import { taskStatusCopy } from '../../../packages/mobile/src/app/MobileRoot';
import { messages } from '../../../packages/mobile/src/i18n';

const text = messages('zh');
const state = (patch: Partial<Parameters<typeof taskStatusCopy>[1]> = {}) => ({
  pending: false, pendingAction: null, runId: null, terminal: null, ...patch,
});

describe('task status copy', () => {
  it('语音转写期间说的是「正在转写」，不是给发送写的那句', () => {
    // 真机反馈：转写时状态行写「正在核对电脑是否已接收，请勿重复发送」——
    // 用户没发送什么，也不存在重复发送的风险。
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }))).toBe(text.transcribing);
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'voice.transcribe' }))).not.toBe(text.pendingCommand);
  });

  it('其余命令仍然用原来的「正在核对电脑是否已接收」', () => {
    for (const action of ['message.send', 'run.cancel', 'approval.respond', 'session.create', null]) {
      expect(taskStatusCopy(text, state({ pending: true, pendingAction: action }))).toBe(text.pendingCommand);
    }
  });

  it('没有待确认命令时，运行中与终态的文案不受影响', () => {
    expect(taskStatusCopy(text, state({ runId: 'run-1' }))).toBe(text.running);
    expect(taskStatusCopy(text, state({ terminal: 'complete' }))).toBe(text.complete);
    expect(taskStatusCopy(text, state())).toBe('');
  });

  it('待确认命令压过运行中状态', () => {
    expect(taskStatusCopy(text, state({ pending: true, pendingAction: 'message.send', runId: 'run-1' }))).toBe(text.pendingCommand);
  });
});
