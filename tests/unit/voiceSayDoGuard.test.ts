import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { QuickModelResult } from '../../src/host/model/quickModel';

const runtime = vi.hoisted(() => ({
  quickTask: vi.fn<(...args: unknown[]) => Promise<QuickModelResult>>(
    async (..._args: unknown[]) => ({ success: true, content: 'NORMAL' }),
  ),
  executeVoiceTool: vi.fn(async (..._args: unknown[]) => '已派发'),
  queueAssistantItemDeletion: vi.fn((_itemId: string, _onDeleted: () => void) => true),
  info: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../../src/host/model/quickModel', () => ({
  quickTask: (...args: unknown[]) => runtime.quickTask(...args),
}));
vi.mock('../../src/host/services/voice/voiceTools', () => ({
  executeVoiceTool: (...args: unknown[]) => runtime.executeVoiceTool(...args),
}));
vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: runtime.info, warn: runtime.warn, error: vi.fn(), debug: vi.fn() }),
}));

import { createVoiceSayDoGuard } from '../../src/host/services/voice/voiceSayDoGuard';

const makeGuard = (isCurrent: () => boolean = () => true) =>
  createVoiceSayDoGuard('voice-session-test', isCurrent, runtime.queueAssistantItemDeletion);

beforeEach(() => {
  runtime.quickTask.mockReset().mockResolvedValue({ success: true, content: 'NORMAL' });
  runtime.executeVoiceTool.mockClear();
  runtime.queueAssistantItemDeletion.mockClear().mockReturnValue(true);
  runtime.info.mockClear();
  runtime.warn.mockClear();
});

describe('voice say/do guard（公共入口）', () => {
  it('有工具调用且无执行声称时照旧跳过，不做语义审计或上下文剔除', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建一个文件');
    guard.rememberToolCall();

    await guard.audit('工具结果返回后我再告诉你。', 'r1', 'a1');
    expect(runtime.quickTask).not.toHaveBeenCalled();
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
    expect(runtime.queueAssistantItemDeletion).not.toHaveBeenCalled();
  });

  it('有工具调用且有执行声称时排队剔除 assistant item，并在真正删除后留审计事件', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建一个文件');
    guard.rememberToolCall();

    await guard.audit('好的，我正在为你创建文件。', 'r-polluted', 'a-polluted');

    expect(runtime.quickTask).not.toHaveBeenCalled();
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
    expect(runtime.queueAssistantItemDeletion).toHaveBeenCalledWith('a-polluted', expect.any(Function));
    expect(runtime.info).not.toHaveBeenCalled();

    const onDeleted = runtime.queueAssistantItemDeletion.mock.calls[0]?.[1];
    onDeleted?.();
    expect(runtime.info).toHaveBeenCalledWith(
      'voice say/do context pollution removed',
      expect.objectContaining({
        responseId: 'r-polluted',
        assistantItemId: 'a-polluted',
        summary: '本轮模型违规输出执行声称，已从上游对话上下文剔除',
        violation: 'execution_claim_with_tool_call',
        action: 'assistant_item_removed_from_upstream_context',
      }),
    );
  });

  it('按语义判为说了没做后用最近用户轮经 host_routed 补派', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建一个一点');
    guard.rememberUserTurn('MD 文件');
    runtime.quickTask.mockImplementationOnce(async (input: unknown) => {
      expect(String(input)).toContain('只输出 SAY_GAP 或 NORMAL');
      expect(String(input)).toContain('帮我创建一个一点');
      expect(String(input)).toContain('MD 文件');
      return { success: true, content: 'SAY_GAP' };
    });

    await guard.audit('马上帮你处理。', 'r2');

    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);
    const [name, rawArguments, origin] = runtime.executeVoiceTool.mock.calls[0] as [string, string, string];
    expect(name).toBe('delegate_task');
    expect(origin).toBe('host_routed');
    const parsed = JSON.parse(rawArguments) as { prompt: string };
    expect(parsed.prompt).toContain('[USER] 帮我创建一个一点');
    expect(parsed.prompt).toContain('[USER] MD 文件');
    expect(runtime.info).toHaveBeenCalledWith(
      'voice say/do guard intervened',
      expect.objectContaining({ action: 'host_routed_delegate_task' }),
    );
    expect(runtime.warn).not.toHaveBeenCalled();
  });

  it('干预后同一轮不重复补派', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我创建文件');
    runtime.quickTask.mockResolvedValueOnce({ success: true, content: 'SAY_GAP' });
    await guard.audit('马上处理。', 'r1');
    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);

    runtime.quickTask.mockResolvedValueOnce({ success: true, content: 'SAY_GAP' });
    await guard.audit('已经在做了。', 'r1-followup');
    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);
  });

  it('闲聊、追问和明确未执行都保持普通回复', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('这个文件要怎么命名比较好');
    await guard.audit('你想偏正式还是偏口语一点？', 'r3');
    expect(runtime.quickTask).toHaveBeenCalledTimes(1);
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
    expect(runtime.queueAssistantItemDeletion).not.toHaveBeenCalled();
  });

  it('审计期间来了更新的用户轮就丢弃旧判定，避免补派过期要求', async () => {
    const guard = makeGuard();
    guard.rememberUserTurn('帮我改文件');
    let resolveClassify!: (value: { success: boolean; content: string }) => void;
    runtime.quickTask.mockImplementationOnce(
      () => new Promise<{ success: boolean; content: string }>((done) => { resolveClassify = done; }),
    );
    const audit = guard.audit('我开始修改。', 'r4');
    guard.rememberUserTurn('算了，先别改');
    resolveClassify({ success: true, content: 'SAY_GAP' });

    await audit;
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });

  it.each([
    ['rate_limited', { success: false, failureReason: 'rate_limited', status: 429, error: '429 code 1305' }],
    ['server_error', { success: false, failureReason: 'server_error', status: 503, error: '503 overloaded' }],
    ['empty_response', { success: false, failureReason: 'empty_response', error: 'empty response' }],
    ['invalid_contract_output', { success: true, content: '我认为需要执行' }],
  ] as const)('分类器 %s 时三条件兜底只补派一次，错误原因随 host_routed 入审计', async (reason, quickResult) => {
    const guard = makeGuard();
    guard.rememberUserTurn('请帮我创建测试.md，内容写你好');
    runtime.quickTask.mockResolvedValue(quickResult);

    await guard.audit('好的，我正在为你创建测试文件。', `fault-${reason}`);
    await guard.audit('好的，我正在为你创建测试文件。', `fault-${reason}-duplicate`);

    expect(runtime.executeVoiceTool).toHaveBeenCalledTimes(1);
    expect(runtime.executeVoiceTool.mock.calls[0]?.[2]).toBe('host_routed');
    expect(runtime.info).toHaveBeenCalledWith(
      'voice say/do guard intervened',
      expect.objectContaining({
        action: 'host_routed_delegate_task',
        decisionSource: 'deterministic_fallback',
        classificationFailure: reason,
      }),
    );
    expect(runtime.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['闲聊', '你好，今天心情怎么样', '我正在想怎么回答你'],
    ['知识问答', 'MD 文件是什么', '我正在解释它的格式'],
    ['追问', '请帮我创建一个文件', '你希望文件叫什么名字？'],
    ['助手未声称执行', '麻烦你整理下载目录', '等你确认范围后我再动手'],
  ])('分类器不可用时反例“%s”不触发确定性补派', async (_name, userText, assistantText) => {
    const guard = makeGuard();
    guard.rememberUserTurn(userText);
    runtime.quickTask.mockResolvedValueOnce({
      success: false,
      failureReason: 'rate_limited',
      status: 429,
      error: '429 code 1305',
    });

    await guard.audit(assistantText, 'negative');

    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
    expect(runtime.warn).toHaveBeenCalledWith(
      'voice say/do guard unavailable',
      expect.objectContaining({ failureReason: 'rate_limited', action: 'no_intervention' }),
    );
  });

  it('会话已切换（isCurrent=false）时判定结果作废不补派', async () => {
    const guard = makeGuard(() => false);
    guard.rememberUserTurn('帮我建个文档');
    runtime.quickTask.mockResolvedValueOnce({ success: true, content: 'SAY_GAP' });

    await guard.audit('马上建。', 'r6');
    expect(runtime.executeVoiceTool).not.toHaveBeenCalled();
  });
});
