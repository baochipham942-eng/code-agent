// startRun 的四种结果 → 回给通话 brain 的话：**四种都不许说「已经开始做了」**，
// 除非活真的开起来了。
//
// 为什么单独立这一组：这句话是通话 brain 下一句的唯一依据，它一旦收到「已经开始」，
// 就会对着电话那头的人说「我已经在给你做了」。同一个 startRun 结果原先在 delegateTask
// 和 steerTask 两处各写一套处理，第二处只处理了 requires_choice——reused 与 queued
// 一起掉进「我已经开始做了」，而活根本没开始（2026-08-15 真机撞到这条形状）。
import { describe, it, expect } from 'vitest';
import { voiceStartRunSpeech } from '../../src/host/services/voice/voiceStartRunSpeech';

const SHORT_NAME = '写入';

/** 「已经开始」的各种说法——模型只要收到其中任何一种就会向用户复述。 */
const STARTED_CLAIMS = ['已经开始', '开始做', '已经在跑', '已经派出'];

describe('startRun 结果 → 通话 brain 台词', () => {
  it('started：这是唯一允许说「已经开始做」的一种', () => {
    const speech = voiceStartRunSpeech(SHORT_NAME, 'started');

    expect(speech).toContain('我已经开始做');
    expect(speech).toContain(SHORT_NAME);
    // 认知协议必须同时下发，否则「开始」离「做完」只差模型一次善意润色。
    expect(speech).toContain('[BACKEND]');
    expect(speech).toContain('task_status');
  });

  it('reused：复用了原任务，没有新活开始——不许说「已经开始」', () => {
    const speech = voiceStartRunSpeech(SHORT_NAME, 'reused');

    expect(speech).toContain('复用');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
  });

  it('queued：还排在别人后面，一行都还没跑——不许说「已经开始」', () => {
    const speech = voiceStartRunSpeech(SHORT_NAME, 'queued');

    expect(speech).toContain('排在');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
  });

  it('requires_choice：正在等用户选，更不该说已经开始', () => {
    const speech = voiceStartRunSpeech(SHORT_NAME, 'requires_choice');

    expect(speech).toContain('等待回答');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
  });

  it('短名原样带进每一种台词：用户听到的必须是他自己那件活的名字', () => {
    for (const outcome of ['started', 'queued', 'reused'] as const) {
      expect(voiceStartRunSpeech('周报', outcome)).toContain('周报');
    }
  });
});
