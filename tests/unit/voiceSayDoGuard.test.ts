import { describe, expect, it, vi, beforeEach } from 'vitest';

const runtime = vi.hoisted(() => ({
  quickTask: vi.fn(async (..._args: unknown[]) => ({ content: 'NORMAL' })),
  executeVoiceTool: vi.fn(async (..._args: unknown[]) => '已派发'),
  warn: vi.fn(),
}));
vi.mock('../../src/host/model/quickModel', () => ({
  quickTask: (...args: unknown[]) => runtime.quickTask(...args),
}));
vi.mock('../../src/host/services/voice/voiceTools', () => ({
  executeVoiceTool: (...args: unknown[]) => runtime.executeVoiceTool(...args),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: runtime.warn, error: vi.fn(), debug: vi.fn() }),
}));

import { createVoiceSayDoGuard } from '../../src/host/services/voice/voiceSayDoGuard';

const makeGuard = (isCurrent: () => boolean = () => true) =>
  createVoiceSayDoGuard('voice-session-test', isCurrent);

beforeEach(() => {
  runtime.quickTask.mockReset().mockResolvedValue({ content: 'NORMAL' });
  runtime.executeVoiceTool.mockClear();
  runtime.warn.mockClear();
});

describe('voice say/do guard（公共入口）', () => {
  it('本轮已经有工具调用时不再做语义审计', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建一个文件');
    guard.rememberToolCall();

    await guard.audit('我正在创建', 'r1');
    expect(runtime.quickTask).not.toHaveBeenCalled();
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });

  it('按语义判为说了没做后用最近用户轮经 host_routed 补派', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建一个一点');
    guard.rememberUserTurn('MD 文件');
    runtime.quickTask.mockImplementationOnce(async (input: unknown) => {
      expect(String(input)).toContain('只输出 SAY_GAP 或 NORMAL');
      expect(String(input)).toContain('帮我创建一个一点');
      expect(String(input)).toContain('MD 文件');
      return { content: 'SAY_GAP' };
    });

    await guard.audit('马上帮你处理。', 'r2');

    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);
    const [name, rawArguments, origin] = runtime.executeVoiceTool.mock.calls[0] as [string, string, string];
    expect(name).toBe('delegate_task');
    expect(origin).toBe('host_routed');
    const parsed = JSON.parse(rawArguments) as { prompt: string };
    expect(parsed.prompt).toContain('[USER] 帮我创建一个一点');
    expect(parsed.prompt).toContain('[USER] MD 文件');
  });

  it('干预后同一轮不重复补派', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建文件');
    runtime.quickTask.mockResolvedValueOnce({ content: 'SAY_GAP' });
    await guard.audit('马上处理。', 'r1');
    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);

    runtime.quickTask.mockResolvedValueOnce({ content: 'SAY_GAP' });
    await guard.audit('已经在做了。', 'r1-followup');
    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);
  });

  it('闲聊、追问和明确未执行都保持普通回复', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('这个文件要怎么命名比较好');
    await guard.audit('你想偏正式还是偏口语一点？', 'r3');
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });

  it('审计期间来了更新的用户轮就丢弃旧判定，避免补派过期要求', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我改文件');
    let resolveClassify!: (value: { content: string }) => void;
    runtime.quickTask.mockImplementationOnce(
      () => new Promise<{ content: string }>((done) => { resolveClassify = done; }),
    );
    const audit = guard.audit('我开始修改。', 'r4');
    guard.rememberUserTurn('算了，先别改');
    resolveClassify({ content: 'SAY_GAP' });

    await audit;
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });

  it('分类服务不可用时不干预并留下可查告警', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我跑测试');
    runtime.quickTask.mockResolvedValueOnce({ content: '嗯，好的' });

    await guard.audit('我现在跑。', 'r5');
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
    expect(runtime.warn).toHaveBeenCalledWith(
      'voice say/do guard unavailable',
      expect.objectContaining({ action: 'no_intervention' }),
    );
  });

  it('会话已切换（isCurrent=false）时判定结果作废不补派', async () => {
    const guard = makeGuard(() => false);
    guard.rememberUserTurn('帮我建个文档');
    runtime.quickTask.mockResolvedValueOnce({ content: 'SAY_GAP' });

    await guard.audit('马上建。', 'r6');
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });
});
