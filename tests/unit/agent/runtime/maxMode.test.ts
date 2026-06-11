// ============================================================================
// Max Mode（best-of-N）单测 — propose-only 并发候选 → judge 选索引 → 赢家 replay
// 设计约束（roadmap 3.3）：
//   a. 候选 propose-only：只产生提案，绝不执行副作用（引擎调用无流式回调、工具
//      schema-only、工具执行发生在 loop 下游，本模块不触碰）
//   b. judge fail-open：判不出/解析失败/调用抛错 → 选索引 0，不阻塞主链路
//   c. 全候选失败 → 降级单次流式调用（用户无感）
//   d. 失败候选 + judge 的 token 计入 overhead（成本），不进上下文长度估算
// ============================================================================

import { describe, expect, it, vi } from 'vitest';
import {
  toSchemaOnlyTools,
  parseJudgeWinner,
  runMaxModeStep,
  JUDGE_SYSTEM_PROMPT,
  type MaxModeEngine,
} from '../../../../src/main/agent/runtime/maxMode';
import type { ModelResponse, ModelMessage } from '../../../../src/main/agent/loopTypes';
import type { ToolDefinition } from '../../../../src/shared/contract';

function makeTool(name: string, extra?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    requiresPermission: false,
    permissionLevel: 'read',
    ...extra,
  } as ToolDefinition;
}

function textResponse(content: string, usage?: { inputTokens: number; outputTokens: number }): ModelResponse {
  return { type: 'text', content, usage };
}

function toolResponse(toolName: string, usage?: { inputTokens: number; outputTokens: number }): ModelResponse {
  return {
    type: 'tool_use',
    toolCalls: [{ id: `call-${toolName}`, name: toolName, arguments: { path: 'a.ts' } }],
    usage,
  };
}

const MESSAGES: ModelMessage[] = [
  { role: 'system', content: 'sys' },
  { role: 'user', content: '修复 bug' },
];
const TOOLS: ToolDefinition[] = [makeTool('read_file'), makeTool('edit_file')];

describe('toSchemaOnlyTools', () => {
  it('防御性剥离 execute 闭包，保留 schema 字段', () => {
    const withExecute = [makeTool('read_file', { execute: vi.fn() })];
    const out = toSchemaOnlyTools(withExecute);
    expect((out[0] as Record<string, unknown>).execute).toBeUndefined();
    expect(out[0].name).toBe('read_file');
    expect(out[0].description).toBe('read_file tool');
    expect(out[0].inputSchema).toEqual({ type: 'object', properties: {} });
  });

  it('不修改入参数组', () => {
    const execute = vi.fn();
    const withExecute = [makeTool('read_file', { execute })];
    toSchemaOnlyTools(withExecute);
    expect((withExecute[0] as Record<string, unknown>).execute).toBe(execute);
  });
});

describe('parseJudgeWinner', () => {
  it('解析 WINNER: <index>', () => {
    expect(parseJudgeWinner('候选 2 的工具调用最合理。\nWINNER: 2', 3)).toEqual({ index: 2, parsed: true });
  });

  it('取最后一个 WINNER（容忍前文复述格式）', () => {
    const out = '格式是 WINNER: 0 这样。\n理由……\nWINNER: 1';
    expect(parseJudgeWinner(out, 3)).toEqual({ index: 1, parsed: true });
  });

  it('容忍 markdown 加粗与中文冒号', () => {
    expect(parseJudgeWinner('**WINNER：1**', 3)).toEqual({ index: 1, parsed: true });
  });

  it('无 WINNER 行 → fail-open 选 0', () => {
    expect(parseJudgeWinner('我觉得候选 2 不错', 3)).toEqual({ index: 0, parsed: false });
  });

  it('索引越界 → fail-open 选 0', () => {
    expect(parseJudgeWinner('WINNER: 7', 3)).toEqual({ index: 0, parsed: false });
  });

  it('空输出 → fail-open 选 0', () => {
    expect(parseJudgeWinner('', 3)).toEqual({ index: 0, parsed: false });
  });
});

describe('runMaxModeStep', () => {
  it('并发跑 N 个候选：全部在任一 resolve 前启动，引擎收到 schema-only 工具且消息一致', async () => {
    let started = 0;
    const resolvers: Array<(r: ModelResponse) => void> = [];
    const silentEngine: MaxModeEngine = vi.fn(async (messages, tools) => {
      if (tools.length > 0) {
        // 候选调用：消息与主链路一致，工具 schema-only
        started++;
        expect(messages).toEqual(MESSAGES);
        for (const tool of tools) {
          expect((tool as Record<string, unknown>).execute).toBeUndefined();
        }
      }
      return new Promise<ModelResponse>((resolve) => resolvers.push(resolve));
    });
    const streamingEngine: MaxModeEngine = vi.fn();

    const promise = runMaxModeStep(
      { silentEngine, streamingEngine },
      { messages: MESSAGES, tools: TOOLS, candidates: 3 },
    );
    await vi.waitFor(() => expect(started).toBe(3));

    // 全部候选已并发启动；现在依次 resolve（候选0/1/2），judge 选 1
    resolvers[0](toolResponse('read_file', { inputTokens: 100, outputTokens: 10 }));
    resolvers[1](toolResponse('edit_file', { inputTokens: 100, outputTokens: 20 }));
    resolvers[2](textResponse('done', { inputTokens: 100, outputTokens: 30 }));
    await vi.waitFor(() => expect(resolvers.length).toBe(4)); // judge 调用也走 silentEngine
    resolvers[3](textResponse('WINNER: 1', { inputTokens: 50, outputTokens: 5 }));

    const { response, stats } = await promise;
    expect(response.toolCalls?.[0].name).toBe('edit_file');
    expect(stats).toMatchObject({ candidates: 3, survivors: 3, winner: 1, degraded: false });
    expect(streamingEngine).not.toHaveBeenCalled();
  });

  it('judge 调用不带工具（纯文本裁决），收到渲染后的候选清单', async () => {
    const calls: Array<{ messages: ModelMessage[]; tools: ToolDefinition[] }> = [];
    const silentEngine: MaxModeEngine = vi.fn(async (messages, tools) => {
      calls.push({ messages, tools });
      if (calls.length <= 2) {
        return calls.length === 1
          ? toolResponse('read_file', { inputTokens: 1, outputTokens: 1 })
          : textResponse('改完了', { inputTokens: 1, outputTokens: 1 });
      }
      return textResponse('WINNER: 0', { inputTokens: 1, outputTokens: 1 });
    });

    await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 2 },
    );

    const judgeCall = calls[2];
    expect(judgeCall.tools).toEqual([]);
    const rendered = JSON.stringify(judgeCall.messages);
    expect(rendered).toContain('read_file');
    expect(rendered).toContain('改完了');
    // judge 系统提示注入（防欺骗措辞在 JUDGE_SYSTEM_PROMPT 内容测试中单独覆盖）
    expect(judgeCall.messages.some((m) => m.role === 'system' && m.content === JUDGE_SYSTEM_PROMPT)).toBe(true);
  });

  it('唯一幸存者 → 跳过 judge 直接 replay', async () => {
    const silentEngine: MaxModeEngine = vi.fn(async () => textResponse('only', { inputTokens: 1, outputTokens: 1 }));
    const { response, stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 1 },
    );
    expect(silentEngine).toHaveBeenCalledTimes(1); // 无 judge 调用
    expect(response.content).toBe('only');
    expect(stats).toMatchObject({ candidates: 1, survivors: 1, winner: 0 });
  });

  it('部分候选失败 → 幸存者参加 judge，索引按幸存者数组解释', async () => {
    let n = 0;
    const silentEngine: MaxModeEngine = vi.fn(async (_m, tools) => {
      if (tools.length === 0) return textResponse('WINNER: 1', { inputTokens: 5, outputTokens: 1 });
      n++;
      if (n === 2) throw new Error('candidate boom');
      return textResponse(`c${n}`, { inputTokens: 10, outputTokens: n });
    });
    const { response, stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 3 },
    );
    // 幸存者 = [c1, c3]，judge 选 1 → c3
    expect(response.content).toBe('c3');
    expect(stats).toMatchObject({ candidates: 3, survivors: 2, winner: 1, degraded: false });
  });

  it('全候选失败 → 降级单次流式调用（带原始工具），用户无感', async () => {
    const silentEngine: MaxModeEngine = vi.fn(async () => {
      throw new Error('all boom');
    });
    const streamingEngine: MaxModeEngine = vi.fn(async (messages, tools) => {
      expect(messages).toEqual(MESSAGES);
      expect(tools).toEqual(TOOLS);
      return textResponse('degraded answer', { inputTokens: 100, outputTokens: 10 });
    });
    const { response, stats } = await runMaxModeStep(
      { silentEngine, streamingEngine },
      { messages: MESSAGES, tools: TOOLS, candidates: 3 },
    );
    expect(response.content).toBe('degraded answer');
    expect(streamingEngine).toHaveBeenCalledTimes(1);
    expect(stats).toMatchObject({ degraded: true, survivors: 0 });
    // 降级调用是正常主链路，不计 overhead
    expect(stats.overhead).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('judge 调用抛错 → fail-open 选 0，不阻塞主链路', async () => {
    let n = 0;
    const silentEngine: MaxModeEngine = vi.fn(async (_m, tools) => {
      if (tools.length === 0) throw new Error('judge boom');
      n++;
      return textResponse(`c${n}`, { inputTokens: 10, outputTokens: 1 });
    });
    const { response, stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 2 },
    );
    expect(response.content).toBe('c1');
    expect(stats.winner).toBe(0);
  });

  it('judge 输出无法解析 → fail-open 选 0', async () => {
    let n = 0;
    const silentEngine: MaxModeEngine = vi.fn(async (_m, tools) => {
      if (tools.length === 0) return textResponse('两个都不错', { inputTokens: 5, outputTokens: 1 });
      n++;
      return textResponse(`c${n}`, { inputTokens: 10, outputTokens: 1 });
    });
    const { response } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 2 },
    );
    expect(response.content).toBe('c1');
  });

  it('overhead = 落选候选 + judge 的 usage 之和，不含赢家；赢家 usage 原样保留在 response 上', async () => {
    let n = 0;
    const silentEngine: MaxModeEngine = vi.fn(async (_m, tools) => {
      if (tools.length === 0) return textResponse('WINNER: 1', { inputTokens: 500, outputTokens: 5 });
      n++;
      return textResponse(`c${n}`, { inputTokens: 1000, outputTokens: n * 10 });
    });
    const { response, stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 3 },
    );
    // 赢家 = c2（outputTokens 20）；落选 c1(10) + c3(30) + judge(5) = overhead
    expect(response.usage).toEqual({ inputTokens: 1000, outputTokens: 20 });
    expect(stats.overhead).toEqual({ inputTokens: 2500, outputTokens: 45 });
  });

  it('候选缺 usage（provider 未返回）→ overhead 按 0 累计，不崩', async () => {
    let n = 0;
    const silentEngine: MaxModeEngine = vi.fn(async (_m, tools) => {
      if (tools.length === 0) return textResponse('WINNER: 0');
      n++;
      return textResponse(`c${n}`);
    });
    const { stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 2 },
    );
    expect(stats.overhead).toEqual({ inputTokens: 0, outputTokens: 0 });
  });

  it('candidates < 1 → 按 1 处理', async () => {
    const silentEngine: MaxModeEngine = vi.fn(async () => textResponse('one', { inputTokens: 1, outputTokens: 1 }));
    const { stats } = await runMaxModeStep(
      { silentEngine, streamingEngine: vi.fn() },
      { messages: MESSAGES, tools: TOOLS, candidates: 0 },
    );
    expect(stats.candidates).toBe(1);
    expect(silentEngine).toHaveBeenCalledTimes(1);
  });
});

describe('JUDGE_SYSTEM_PROMPT 防欺骗措辞（roadmap 1.4 三件套，对齐 goalReviewGate 风格）', () => {
  it('要求引用证据、不采信候选自报、解析失败有保守缺省', () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('引用');
    expect(JUDGE_SYSTEM_PROMPT).toContain('证据不是证明');
    expect(JUDGE_SYSTEM_PROMPT).toContain('WINNER:');
  });
});
