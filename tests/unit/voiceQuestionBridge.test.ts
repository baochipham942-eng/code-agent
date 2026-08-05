import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserQuestion, UserQuestionRequest, UserQuestionResponse } from '../../src/shared/contract';

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const bridge = await import('../../src/host/services/voice/voiceQuestionBridge');

const question: UserQuestion = {
  header: '处理方式',
  question: '这份报告怎么处理？',
  options: [
    { label: '批准方案', description: '按当前版本继续' },
    { label: '退回修改', description: '补充数据后重提' },
    { label: '暂时搁置', description: '本轮不处理' },
  ],
};

function request(questions: UserQuestion[] = [question]): UserQuestionRequest {
  return { id: 'q-1', sessionId: 'session-1', questions, timestamp: 1 };
}

const speak = vi.fn();
const dismiss = vi.fn();
const respond = vi.fn((_response: UserQuestionResponse) => undefined);

beforeEach(() => {
  bridge.endVoiceQuestionSession('session-1');
  speak.mockReset();
  dismiss.mockReset();
  respond.mockReset();
  bridge.beginVoiceQuestionSession({ neoSessionId: 'session-1', speak, dismiss });
});

describe('voice question answer matching', () => {
  it('支持选项名、编号和唯一模糊匹配', () => {
    expect(bridge.matchVoiceQuestionAnswer(question, '退回修改')).toBe('退回修改');
    expect(bridge.matchVoiceQuestionAnswer(question, '选第二个')).toBe('退回修改');
    expect(bridge.matchVoiceQuestionAnswer(question, '批准方按')).toBe('批准方案');
  });

  it('多选按用户明确说出的多个编号映射', () => {
    expect(bridge.matchVoiceQuestionAnswer({ ...question, multiSelect: true }, '第一和第三')).toEqual([
      '批准方案',
      '暂时搁置',
    ]);
  });

  it('无法唯一确认时返回 null', () => {
    expect(bridge.matchVoiceQuestionAnswer(question, '都差不多')).toBeNull();
  });
});

describe('voice question lifecycle', () => {
  it('念出问题与选项，回答后复用既有 UserQuestionResponse', () => {
    expect(bridge.offerVoiceQuestion(request(), respond)).toBe(true);
    expect(speak).toHaveBeenCalledWith(expect.objectContaining({
      narrationId: 'voice-question:q-1:0:ask',
      title: '处理方式',
    }));
    expect(speak.mock.calls[0]?.[0].text).toContain('1，批准方案');

    expect(bridge.handleVoiceQuestionTranscript('session-1', '第二个')).toBe(true);
    expect(respond).toHaveBeenCalledWith({
      requestId: 'q-1',
      answers: { 处理方式: '退回修改' },
    });
  });

  it('模糊回答只追问一次，第二次仍不清楚则保留文字选项卡', () => {
    bridge.offerVoiceQuestion(request(), respond);

    expect(bridge.handleVoiceQuestionTranscript('session-1', '随便')).toBe(true);
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({
      narrationId: 'voice-question:q-1:0:retry',
    }));
    expect(bridge.handleVoiceQuestionTranscript('session-1', '还是随便')).toBe(true);
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({
      narrationId: 'voice-question:q-1:0:card',
    }));
    expect(respond).not.toHaveBeenCalled();
  });

  it('多道问题逐题念出，收齐后一次提交答案', () => {
    const second: UserQuestion = {
      header: '发布时间',
      question: '什么时候发布？',
      options: [
        { label: '今天', description: '今天发布' },
        { label: '明天', description: '明天发布' },
      ],
    };
    bridge.offerVoiceQuestion(request([question, second]), respond);

    bridge.handleVoiceQuestionTranscript('session-1', '批准方案');
    expect(speak).toHaveBeenLastCalledWith(expect.objectContaining({
      narrationId: 'voice-question:q-1:1:ask',
      title: '发布时间',
    }));
    bridge.handleVoiceQuestionTranscript('session-1', '明天');
    expect(respond).toHaveBeenCalledWith({
      requestId: 'q-1',
      answers: { 处理方式: '批准方案', 发布时间: '明天' },
    });
  });
});
