import { describe, expect, it, vi } from 'vitest';
import {
  auditVoiceSayDoTurn,
  createVoiceSayDoGuardState,
  rememberVoiceSayDoToolCall,
  rememberVoiceSayDoUserTurn,
} from '../../src/host/services/voice/voiceSayDoGuard';

describe('voice say/do guard', () => {
  it('本轮已经有工具调用时不再做语义审计', async () => {
    const state = createVoiceSayDoGuardState();
    rememberVoiceSayDoUserTurn(state, '帮我创建一个文件');
    rememberVoiceSayDoToolCall(state);
    const classifier = vi.fn(async () => 'say_without_do' as const);

    await expect(auditVoiceSayDoTurn(state, '我正在创建', classifier)).resolves.toEqual({
      kind: 'skip', reason: 'tool_observed',
    });
    expect(classifier).not.toHaveBeenCalled();
  });

  it('按语义判为说了没做后返回最近用户轮组成的补派指令', async () => {
    const state = createVoiceSayDoGuardState();
    rememberVoiceSayDoUserTurn(state, '帮我创建一个一点');
    rememberVoiceSayDoUserTurn(state, 'MD 文件');

    const result = await auditVoiceSayDoTurn(
      state,
      '马上帮你处理。',
      async (input) => {
        expect(input).toContain('只按语义判断，不依赖固定句式');
        expect(input).toContain('帮我创建一个一点');
        expect(input).toContain('MD 文件');
        return 'say_without_do';
      },
    );

    expect(result).toMatchObject({ kind: 'intervene', turnVersion: 2 });
    if (result.kind === 'intervene') {
      expect(result.prompt).toContain('[USER] 帮我创建一个一点');
      expect(result.prompt).toContain('[USER] MD 文件');
    }
  });

  it('闲聊、追问和明确未执行都保持普通回复', async () => {
    const state = createVoiceSayDoGuardState();
    rememberVoiceSayDoUserTurn(state, '这个文件要怎么命名比较好');
    await expect(auditVoiceSayDoTurn(
      state,
      '你想偏正式还是偏口语一点？',
      async () => 'normal_reply',
    )).resolves.toEqual({ kind: 'normal' });
  });

  it('审计期间来了更新的用户轮就丢弃旧判定，避免补派过期要求', async () => {
    const state = createVoiceSayDoGuardState();
    rememberVoiceSayDoUserTurn(state, '帮我改文件');
    let resolve!: (value: 'say_without_do') => void;
    const classifier = () => new Promise<'say_without_do'>((done) => { resolve = done; });
    const audit = auditVoiceSayDoTurn(state, '我开始修改。', classifier);
    rememberVoiceSayDoUserTurn(state, '算了，先别改');
    resolve('say_without_do');

    await expect(audit).resolves.toEqual({ kind: 'skip', reason: 'stale' });
  });

  it('分类服务不可用时显式返回 unavailable', async () => {
    const state = createVoiceSayDoGuardState();
    rememberVoiceSayDoUserTurn(state, '帮我跑测试');
    await expect(auditVoiceSayDoTurn(state, '我现在跑。', async () => null)).resolves.toEqual({
      kind: 'unavailable',
    });
  });
});
