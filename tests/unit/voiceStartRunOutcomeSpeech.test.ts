// startRun 的四种结果 → 回给通话 brain 的话：**四种都不许说「已经开始做了」**，
// 除非活真的开起来了。
//
// 为什么单独立这一组：这句话是通话 brain 下一句的唯一依据，它一旦收到「已经开始」，
// 就会对着电话那头的人说「我已经在给你做了」。同一个 startRun 结果原先在 delegateTask
// 和 steerTask 两处各写一套处理，第二处只处理了 requires_choice——reused 与 queued
// 一起掉进「我已经开始做了」，而活根本没开始（2026-08-15 真机撞到这条形状）。
//
// 这里直接测那个单一出口，而不是去构造「账本没活、并发池却满了」的状态不同步局面：
// 后者的构造成本远高于被测逻辑本身，且构造出来的也只是同一个函数的同一个分支。
import { describe, it, expect, vi } from 'vitest';
import type { VoiceSpawnRequest } from '../../src/shared/contract/voice';

const promptUserInChat = vi.fn(async () => ({ status: 'cancelled' as const }));

vi.mock('../../src/host/tools/utils/userQuestionPrompt', () => ({
  promptUserInChat: (...args: unknown[]) => promptUserInChat(...(args as [])),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/task', () => ({ getTaskManager: () => ({ on: vi.fn(), off: vi.fn() }) }));

const { describeStartRunOutcome } = await import('../../src/host/services/voice/voiceAgentCoordinator');

const request: VoiceSpawnRequest = {
  title: '把七六零写进一点.md',
  prompt: '把七六零写进一点.md',
  shortName: '写入',
  laneKey: 'legacy:写入',
  submissionKey: 'legacy:w-1',
};

/** 只造 describeStartRunOutcome 真正会碰到的那几个字段。 */
function fakeState(): never {
  return { items: new Map(), neoSessionId: 'session-1' } as never;
}

/** 「已经开始」的各种说法——模型只要收到其中任何一种就会向用户复述。 */
const STARTED_CLAIMS = ['已经开始', '开始做', '已经在跑', '已经派出'];

describe('startRun 结果 → 通话 brain 台词', () => {
  it('started：这是唯一允许说「已经开始做」的一种', () => {
    const speech = describeStartRunOutcome(fakeState(), request, { outcome: 'started', workItemId: 'w-1' });

    expect(speech).toContain('我已经开始做');
    expect(speech).toContain(request.shortName);
    // 认知协议必须同时下发，否则「开始」离「做完」只差模型一次善意润色。
    expect(speech).toContain('[BACKEND]');
  });

  it('reused：复用了原任务，没有新活开始——不许说「已经开始」', () => {
    const speech = describeStartRunOutcome(fakeState(), request, { outcome: 'reused', workItemId: 'w-0' });

    expect(speech).toContain('复用');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
  });

  it('queued：还排在别人后面，一行都还没跑——不许说「已经开始」', () => {
    const speech = describeStartRunOutcome(fakeState(), request, { outcome: 'queued', workItemId: 'w-2' });

    expect(speech).toContain('排在');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
  });

  it('requires_choice：正在等用户选，更不该说已经开始，且必须真的弹出选择', () => {
    promptUserInChat.mockClear();

    const speech = describeStartRunOutcome(fakeState(), request, { outcome: 'requires_choice' });

    expect(speech).toContain('等待回答');
    for (const claim of STARTED_CLAIMS) expect(speech).not.toContain(claim);
    // 光在话里说「已请用户选择」不算数——选择框没弹出来就是把用户晾在那儿。
    expect(promptUserInChat).toHaveBeenCalledTimes(1);
  });
});
