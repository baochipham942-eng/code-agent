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

describe('声纹门（N-L7-SPK 判据3 协议级正负成对）', () => {
  it('负例：陌生声纹说正常人话（电视台词形态）→ 不取消播报，speakerGated 记账', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 2_400,
      text: '明天上海的天气还是不错的',
      stage: 'final',
      speakerMismatch: true,
    })).toMatchObject({ classification: 'background', cancel: false, shouldRespond: false, speakerGated: true });
  });

  it('正例：同一句话来自匹配的说话人 → 兜底照旧取消（行为与今天完全一致）', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 2_400,
      text: '明天上海的天气还是不错的',
      stage: 'final',
      speakerMismatch: false,
    })).toMatchObject({ classification: 'true_interrupt', cancel: true });
  });

  it('救援词永远有效：哪怕声纹 mismatch，显式打断词照样取消（判错后果只能是体验差一点）', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 400,
      text: '停一下',
      stage: 'final',
      speakerMismatch: true,
    })).toMatchObject({ classification: 'true_interrupt', cancel: true });
  });

  it('未提供声纹证据（unknown/未启用）→ 与现状完全一致（fail-open）', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 2_400,
      text: '明天上海的天气还是不错的',
      stage: 'final',
    })).toMatchObject({ classification: 'true_interrupt', cancel: true });
  });

  it('声纹 mismatch 不影响豁免枚举（附和仍是附和，不会被误标 gated）', () => {
    expect(decideVoiceInterrupt({
      assistantPlaying: true,
      durationMs: 420,
      text: '好的',
      stage: 'final',
      speakerMismatch: true,
    })).toMatchObject({ classification: 'acknowledgement', cancel: false });
  });
});
