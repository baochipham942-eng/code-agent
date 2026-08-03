import { describe, expect, it } from 'vitest';
import { decideVoiceInterrupt, shouldDisarmHangup } from '../../src/host/services/voice/voiceTurnTaking';

describe('voice turn-taking semantic gate', () => {
  it.each(['嗯', '好的', '知道了', '好的，知道了。', '明白了'])('%s 是附和，不取消也不新建回复', (text) => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 420,
      text,
      stage: 'final',
    })).toMatchObject({
      classification: 'acknowledgement',
      cancel: false,
      shouldRespond: false,
    });
  });

  it.each(['等一下', '停', '改成从十倒数到一', '不要挂断'])('%s 保持真打断或反悔语义', (text) => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 420,
      text,
      stage: 'final',
    })).toMatchObject({ classification: 'true_interrupt', cancel: true });
  });

  it('明确抢话可在 partial 阶段快速取消，final 才请求新回复', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 180,
      text: '等一下',
      stage: 'partial',
    })).toMatchObject({ classification: 'true_interrupt', cancel: true, shouldRespond: false });
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 900,
      text: '等一下，改成从十倒数到一',
      stage: 'final',
    })).toMatchObject({ classification: 'true_interrupt', cancel: true, shouldRespond: true });
  });

  it('挂断附和不撤武装，明确不要挂断会撤武装', () => {
    expect(shouldDisarmHangup('好的，知道了。')).toBe(false);
    expect(shouldDisarmHangup('不要挂断')).toBe(true);
  });
});
