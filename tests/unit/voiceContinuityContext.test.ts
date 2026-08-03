import { describe, expect, it, vi } from 'vitest';
import type { Message, MessageMetadata } from '../../src/shared/contract/message';
import type { VoiceContinuityContext } from '../../src/host/services/voice/voiceContextAssembler';

vi.mock('../../src/host/services/voice/voiceVocabulary', () => ({
  buildVocabularyBlock: () => '',
}));

const {
  VOICE_CONTINUITY_MAX_AGE_MS,
  VOICE_CONTINUITY_TRANSCRIPT_LIMIT,
  buildRecentVoiceBlock,
  buildScreenContextBlock,
  composeVoiceInstructions,
} = await import('../../src/host/services/voice/voiceContextAssembler');

const NOW = new Date(2026, 7, 2, 12, 0, 0).getTime();
const CALL_STARTED_AT = NOW - 20 * 60_000;
const CALL_ENDED_AT = NOW - 10 * 60_000;

function message(
  id: string,
  role: Message['role'],
  content: string,
  timestamp: number,
  metadata?: MessageMetadata,
): Message {
  return { id, role, content, timestamp, metadata };
}

function transcript(id: string, role: 'user' | 'assistant', content: string, timestamp: number): Message {
  return message(id, role, content, timestamp, { source: 'voice' });
}

function summary(endedAt = CALL_ENDED_AT, startedAt = CALL_STARTED_AT): Message {
  return message('summary', 'system', '语音通话结束', endedAt, {
    source: 'voice',
    voiceCallSummary: {
      durationSec: Math.round((endedAt - startedAt) / 1_000),
      provider: 'qwen-omni',
      conversationModel: 'qwen3-omni-flash-realtime',
      workItemCount: 0,
      transcriptCount: 2,
      startedAt,
      endedAt,
    },
  });
}

function context(overrides: Partial<VoiceContinuityContext> = {}): VoiceContinuityContext {
  return {
    neoSessionId: 'neo-1',
    sourceSessionId: 'neo-1',
    messages: [
      transcript('u1', 'user', '继续做发布说明。', CALL_STARTED_AT + 1),
      transcript('a1', 'assistant', '我先整理验证证据。', CALL_STARTED_AT + 2),
      summary(),
    ],
    taskState: { status: 'idle' as const },
    now: NOW,
    ...overrides,
  };
}

describe('新拨号的 Recent voice 门槛', () => {
  it('同一 Neo 会话且在时限内时生成非空块', () => {
    const out = buildRecentVoiceBlock(context());
    expect(out).toContain('[Context — Recent voice]');
    expect(out).toContain('用户：继续做发布说明。');
    expect(out).toContain('我：我先整理验证证据。');
    expect(out).toContain('不要主动开口复述');
  });

  it('跨 Neo 会话时返回空串且不留标题', () => {
    expect(buildRecentVoiceBlock(context({ sourceSessionId: 'neo-2' }))).toBe('');
  });

  it('超过两小时时返回空串', () => {
    const endedAt = NOW - VOICE_CONTINUITY_MAX_AGE_MS;
    expect(buildRecentVoiceBlock(context({
      messages: [
        transcript('u1', 'user', '旧话题。', endedAt - 1_000),
        summary(endedAt, endedAt - 2_000),
      ],
    }))).toBe('');
  });

  it('没有历史 transcript 时返回空串', () => {
    expect(buildRecentVoiceBlock(context({ messages: [summary()] }))).toBe('');
  });

  it('即使不足两小时，跨自然日也不注入', () => {
    const now = new Date(2026, 7, 2, 0, 30).getTime();
    const endedAt = new Date(2026, 7, 1, 23, 30).getTime();
    expect(buildRecentVoiceBlock(context({
      now,
      messages: [transcript('u1', 'user', '昨天的话题。', endedAt - 1), summary(endedAt, endedAt - 2)],
    }))).toBe('');
  });
});

describe('Recent voice 内容与成本边界', () => {
  it('只保留上一通最后 N 条 final transcript', () => {
    const transcripts = Array.from({ length: VOICE_CONTINUITY_TRANSCRIPT_LIMIT + 2 }, (_, index) => (
      transcript(`u${index}`, 'user', `第 ${index} 条。`, CALL_STARTED_AT + index)
    ));
    const out = buildRecentVoiceBlock(context({ messages: [...transcripts, summary()] }));
    expect(out).not.toContain('第 0 条。');
    expect(out).not.toContain('第 1 条。');
    expect(out.match(/^- 用户：/gm)).toHaveLength(VOICE_CONTINUITY_TRANSCRIPT_LIMIT);
  });

  it('超长内容改成完整句摘要，不截出半句', () => {
    const oversizedSentence = `这句不能只留半截${'很长'.repeat(180)}。`;
    const out = buildRecentVoiceBlock(context({
      messages: [
        transcript('u1', 'user', `先确认发布范围。${oversizedSentence}`, CALL_STARTED_AT + 1),
        summary(),
      ],
    }));
    expect(out).toContain('摘要：先确认发布范围。');
    expect(out).toContain('其余内容保留在会话记录里');
    expect(out).not.toContain('这句不能只留半截');
  });

  it('TaskManager 有状态时写入未落地工作，无状态时不伪报', () => {
    const dispatch = message('dispatch', 'user', '整理发布说明', CALL_STARTED_AT + 3, {
      voiceDispatch: { title: '整理发布说明', workItemId: 'work-1' },
    });
    const messages = [
      transcript('u1', 'user', '继续做发布说明。', CALL_STARTED_AT + 1),
      dispatch,
      summary(),
    ];
    expect(buildRecentVoiceBlock(context({ messages, taskState: { status: 'running', startTime: NOW - 1_000 } })))
      .toContain('未落地工作“整理发布说明”：正在处理');
    expect(buildRecentVoiceBlock(context({ messages, taskState: { status: 'idle' } })))
      .not.toContain('未落地工作');
  });

  it('已有结局印章的工作不再注入', () => {
    const messages = [
      transcript('u1', 'user', '继续做发布说明。', CALL_STARTED_AT + 1),
      message('dispatch', 'user', '整理发布说明', CALL_STARTED_AT + 2, {
        voiceDispatch: { title: '整理发布说明', workItemId: 'work-1' },
      }),
      message('settled', 'system', '已完成', CALL_STARTED_AT + 3, {
        source: 'voice',
        voiceWorkSettled: { title: '整理发布说明', workItemId: 'work-1', outcome: 'done' },
      }),
      summary(),
    ];
    expect(buildRecentVoiceBlock(context({ messages, taskState: { status: 'running' } })))
      .not.toContain('未落地工作');
  });
});

describe('instructions 组合零回归与屏幕占位', () => {
  it('没有 continuity 时输出与改动前逐字节相同', () => {
    expect(composeVoiceInstructions('你是牧之', null)).toBe('你是牧之');
    expect(composeVoiceInstructions('你是牧之', { filePath: '/repo/a.ts' })).toBe([
      '你是牧之',
      '[Context — Focus]\n- 当前文件：/repo/a.ts\n用户说「这个」「这里」「当前这个文件」时，多半指的就是上面这些。不确定就问一句，别猜。',
    ].join('\n\n'));
  });

  it('Recent voice 在 Focus 后、口述词表前的正对照可观测', () => {
    const out = composeVoiceInstructions('你是牧之', { filePath: '/repo/a.ts' }, { continuity: context() });
    const focusAt = out.indexOf('[Context — Focus]');
    const recentAt = out.indexOf('[Context — Recent voice]');
    expect(recentAt).toBeGreaterThan(focusAt);
    expect(recentAt).toBeGreaterThanOrEqual(0);
    expect(out.slice(recentAt)).toContain('用户：继续做发布说明。');
  });

  it('screenContextEnabled 默认关闭；开启后给出「只在指屏时拍 + 你看不到画面」的策略', () => {
    expect(buildScreenContextBlock(false)).toBe('');
    expect(composeVoiceInstructions('你是牧之', null)).not.toContain('[Context — Screen]');

    const block = buildScreenContextBlock(true);
    // 策略双写的语音侧那一半：工具名要对得上注册面，不然写了也没人调。
    expect(block).toContain('capture_screen_context');
    // 两条硬点缺一不可——只写「能看屏」会让模型见缝插针地拍，
    // 不写「你看不到」会让它顺嘴编一段画面描述（本仓最容易出的那种谎）。
    expect(block).toContain('只在他明确指屏时调');
    expect(block).toContain('不会给你看');
  });
});
