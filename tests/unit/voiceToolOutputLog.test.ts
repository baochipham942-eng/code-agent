// executeVoiceTool 的回灌文本必须落盘——它是通话 brain 下一句话的唯一事实来源。
//
// 这组用例钉的是「三条出口一条都不能漏」：参数解析失败、正常派发、抛异常，走的是
// 函数里三个不同的 return，很容易只给其中一条加日志就收工。2026-08-15 真机就是栽在
// 这里——模型对用户说「我已经写入了」，而日志里查不到它究竟收到了哪一句返回值，
// 「模型撒谎」和「链路给了它错误的成功信号」根本分不开。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const logInfo = vi.fn();
const logWarn = vi.fn();
const dispatchVoiceIntent = vi.fn();

vi.mock('../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: logInfo, warn: logWarn, error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../src/host/services/voice/voiceAgentCoordinator', () => ({
  dispatchVoiceIntent: (...args: unknown[]) => dispatchVoiceIntent(...args),
}));

const { executeVoiceTool } = await import('../../src/host/services/voice/voiceTools');

/** 取最后一条 'voice tool output' 的载荷；没有就返回 undefined（断言侧好读）。 */
function lastOutputLog(): Record<string, unknown> | undefined {
  const hit = [...logInfo.mock.calls].reverse().find((c) => c[0] === 'voice tool output');
  return hit?.[1] as Record<string, unknown> | undefined;
}

describe('executeVoiceTool 回灌文本落盘', () => {
  beforeEach(() => {
    logInfo.mockClear();
    logWarn.mockClear();
    dispatchVoiceIntent.mockReset();
  });

  it('出口1 参数解析失败：不进 dispatch，回灌的那句人话照样落盘', async () => {
    const output = await executeVoiceTool('cancel_task', '这不是 JSON');

    expect(dispatchVoiceIntent).not.toHaveBeenCalled();
    expect(output).toContain('什么都没停');
    expect(lastOutputLog()).toMatchObject({ name: 'cancel_task', output });
  });

  it('出口2 正常派发：落的是 dispatch 的真实返回值，不是「调用成功」之类的转述', async () => {
    dispatchVoiceIntent.mockResolvedValue('「一点」刚刚已经结束，什么都没改。');

    const output = await executeVoiceTool('task_status', '{}');

    expect(output).toBe('「一点」刚刚已经结束，什么都没改。');
    expect(lastOutputLog()).toMatchObject({
      name: 'task_status',
      output: '「一点」刚刚已经结束，什么都没改。',
      truncated: false,
    });
  });

  it('出口3 抛异常：兜底文案也要落盘，否则失败轮在日志里是空白', async () => {
    dispatchVoiceIntent.mockRejectedValue(new Error('TaskManager not initialized'));

    const output = await executeVoiceTool('task_status', '{}');

    expect(output).toContain('工具执行失败');
    expect(lastOutputLog()).toMatchObject({ name: 'task_status', output });
  });

  it('origin 一起落盘：host 侧确定性路由和模型自己调，事后要能分开', async () => {
    dispatchVoiceIntent.mockResolvedValue('已停下。');

    await executeVoiceTool('task_status', '{}', 'host_routed');

    expect(lastOutputLog()).toMatchObject({ origin: 'host_routed' });
  });

  it('超长返回值截断并显式标记：别让「被截断」和「本来就这么短」看起来一样', async () => {
    const long = '任务'.repeat(600);
    dispatchVoiceIntent.mockResolvedValue(long);

    const output = await executeVoiceTool('task_status', '{}');

    expect(output).toBe(long); // 回灌给模型的仍是全文，截断只发生在日志侧
    const logged = lastOutputLog();
    expect(logged?.truncated).toBe(true);
    expect((logged?.output as string).length).toBeLessThan(long.length);
  });
});
