// Mock-replay unit tests for the workflow-description A/B scorer
// (N-WORKFLOW-BACKGROUND-AB-GLM). Fully hermetic: hand-written GLM-shaped
// responses and a stubbed fetch — no network, no key, no result file.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  AbAuthError,
  AbBadShapeError,
  AbModelNotFoundError,
  AbNetworkError,
  aggregateRates,
  extractToolCallNames,
  extractUsage,
  postChatCompletion,
  requireCodingApiKey,
  scoreQuestion,
  validateQuestions,
  type FetchLike,
} from '../../../packages/internal/evaluation-center/scripts/acceptance/workflow-background-ab-scorer';

const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURES_DIR = path.resolve(
  REPO_ROOT,
  'packages/internal/evaluation-center/scripts/acceptance/fixtures',
);
const SCHEMA_SOURCE_PATH = path.resolve(
  REPO_ROOT,
  'src/host/tools/modules/multiagent/workflow.schema.ts',
);

function glimResponse(toolCallNames: string[]): unknown {
  return {
    id: 'resp_1',
    object: 'chat.completion',
    choices: [
      {
        index: 0,
        finish_reason: toolCallNames.length > 0 ? 'tool_calls' : 'stop',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: toolCallNames.map((name, index) => ({
            id: `call_${index + 1}`,
            type: 'function',
            function: { name, arguments: '{}' },
          })),
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 24, total_tokens: 124 },
  };
}

function responseWithoutToolCalls(): unknown {
  return {
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '直接回答。' } }],
    usage: { prompt_tokens: 50, completion_tokens: 10, total_tokens: 60 },
  };
}

function stubFetch(status: number, body: string): FetchLike {
  return async () => new Response(body, { status, headers: { 'Content-Type': 'application/json' } });
}

describe('scoreQuestion 判定矩阵（mock 回放）', () => {
  it('named + workflow 调用 → 真阳性（opened 且 pass）', () => {
    const verdict = scoreQuestion('named', extractToolCallNames(glimResponse(['workflow'])));
    expect(verdict).toEqual({ opened: true, pass: true });
  });

  it('named + 混在其他工具里的 workflow 调用 → 仍算 opened', () => {
    const verdict = scoreQuestion('named', extractToolCallNames(glimResponse(['Read', 'workflow', 'Bash'])));
    expect(verdict).toEqual({ opened: true, pass: true });
  });

  it('named + 只调了别的工具 → fail', () => {
    const verdict = scoreQuestion('named', extractToolCallNames(glimResponse(['Read'])));
    expect(verdict).toEqual({ opened: false, pass: false });
  });

  it('named + 无任何工具调用 → fail', () => {
    const verdict = scoreQuestion('named', extractToolCallNames(responseWithoutToolCalls()));
    expect(verdict).toEqual({ opened: false, pass: false });
  });

  it('unnamed + 无 workflow 调用 → 真阴性（pass）', () => {
    const verdict = scoreQuestion('unnamed', extractToolCallNames(responseWithoutToolCalls()));
    expect(verdict).toEqual({ opened: false, pass: true });
  });

  it('unnamed + 只调了别的工具 → pass（别的工具不犯规）', () => {
    const verdict = scoreQuestion('unnamed', extractToolCallNames(glimResponse(['WebSearch', 'Read'])));
    expect(verdict).toEqual({ opened: false, pass: true });
  });

  it('unnamed + workflow 调用 → fail（误开）', () => {
    const verdict = scoreQuestion('unnamed', extractToolCallNames(glimResponse(['workflow'])));
    expect(verdict).toEqual({ opened: true, pass: false });
  });
});

describe('aggregateRates 汇率', () => {
  it('named 命中率与 unnamed 误开率分桶计算', () => {
    const rows = [
      { group: 'named' as const, opened: true },
      { group: 'named' as const, opened: true },
      { group: 'named' as const, opened: true },
      { group: 'named' as const, opened: false },
      { group: 'unnamed' as const, opened: true },
      { group: 'unnamed' as const, opened: true },
      { group: 'unnamed' as const, opened: false },
      { group: 'unnamed' as const, opened: false },
      { group: 'unnamed' as const, opened: false },
    ];
    expect(aggregateRates(rows)).toEqual({
      named: { total: 4, opened: 3, hitRate: 0.75 },
      unnamed: { total: 5, opened: 2, falseOpenRate: 0.4 },
    });
  });

  it('空输入 → 两组计数为 0、比率为 0（不产生 NaN）', () => {
    expect(aggregateRates([])).toEqual({
      named: { total: 0, opened: 0, hitRate: 0 },
      unnamed: { total: 0, opened: 0, falseOpenRate: 0 },
    });
  });
});

describe('extractToolCallNames 映射规则', () => {
  it('只读 choices[0].message.tool_calls[].function.name，顺序保留', () => {
    const response = {
      choices: [
        {
          message: {
            tool_calls: [
              { function: { name: 'Read', arguments: '{"path":"/tmp/a"}' } },
              { function: { name: 'workflow', arguments: '{"script":"phase(1)"}' } },
            ],
          },
        },
        { message: { tool_calls: [{ function: { name: 'choices1MustBeIgnored', arguments: '{}' } }] } },
      ],
    };
    expect(extractToolCallNames(response)).toEqual(['Read', 'workflow']);
  });

  it('message 无 tool_calls 字段 → 空列表（合法：模型直接回答）', () => {
    expect(extractToolCallNames(responseWithoutToolCalls())).toEqual([]);
  });

  it('非预期形状 → AbBadShapeError', () => {
    const bad: unknown[] = [
      null,
      'string',
      {},
      { choices: [] },
      { choices: [{ noMessage: true }] },
      { choices: [{ message: { tool_calls: 'not-array' } }] },
      { choices: [{ message: { tool_calls: [{ function: { name: 123 } }] } }] },
      { choices: [{ message: { tool_calls: [{}] } }] },
    ];
    for (const candidate of bad) {
      expect(() => extractToolCallNames(candidate)).toThrow(AbBadShapeError);
    }
  });
});

describe('extractUsage', () => {
  it('映射 prompt/completion/total', () => {
    expect(extractUsage(glimResponse([]))).toEqual({ promptTokens: 100, completionTokens: 24, totalTokens: 124 });
  });

  it('total_tokens 缺席 → prompt+completion 兜底', () => {
    expect(extractUsage({ usage: { prompt_tokens: 7, completion_tokens: 3 } })).toEqual({
      promptTokens: 7,
      completionTokens: 3,
      totalTokens: 10,
    });
  });

  it('usage 缺失或字段非数值 → AbBadShapeError', () => {
    expect(() => extractUsage({})).toThrow(AbBadShapeError);
    expect(() => extractUsage({ usage: { prompt_tokens: 'x', completion_tokens: 1 } })).toThrow(AbBadShapeError);
    expect(() => extractUsage({ usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 'y' } })).toThrow(AbBadShapeError);
  });
});

describe('postChatCompletion 失败分类（stubbed fetch）', () => {
  const request = (fetchImpl: FetchLike) => ({
    endpoint: 'http://stub.test/api/coding/paas/v4/chat/completions',
    apiKey: 'stub-key',
    body: { model: 'glm-5.3', messages: [] },
    fetchImpl,
  });

  it('401 → AbAuthError（fail-loud 出口：不写结果）', async () => {
    await expect(
      postChatCompletion(request(stubFetch(401, JSON.stringify({ error: { code: '1001', message: 'invalid api key' } })))),
    ).rejects.toBeInstanceOf(AbAuthError);
  });

  it('403 → AbAuthError', async () => {
    await expect(
      postChatCompletion(request(stubFetch(403, JSON.stringify({ error: { message: 'forbidden' } })))),
    ).rejects.toBeInstanceOf(AbAuthError);
  });

  it('404 model not found → AbModelNotFoundError', async () => {
    await expect(
      postChatCompletion(
        request(stubFetch(404, JSON.stringify({ error: { code: '1211', message: 'model not found: glm-5.3' } }))),
      ),
    ).rejects.toBeInstanceOf(AbModelNotFoundError);
  });

  it('400 + body 里 model not found → AbModelNotFoundError', async () => {
    await expect(
      postChatCompletion(request(stubFetch(400, JSON.stringify({ error: { message: 'model glm-5.3 not found' } })))),
    ).rejects.toBeInstanceOf(AbModelNotFoundError);
  });

  it('其他非 2xx → 一般 Error（同样 fail-loud，但不是 auth/model 类）', async () => {
    await expect(
      postChatCompletion(request(stubFetch(500, JSON.stringify({ error: { message: 'internal' } })))),
    ).rejects.toThrow(/^endpoint returned http-500/);
  });

  it('200 但非 JSON → AbBadShapeError', async () => {
    await expect(postChatCompletion(request(stubFetch(200, '<html>gateway</html>')))).rejects.toBeInstanceOf(AbBadShapeError);
  });

  it('200 + 正常 body → 走真实映射规则可解出 workflow 调用', async () => {
    const response = await postChatCompletion(request(stubFetch(200, JSON.stringify(glimResponse(['workflow'])))));
    expect(extractToolCallNames(response)).toEqual(['workflow']);
  });

  it('传输层失败 → AbNetworkError', async () => {
    const rejecting: FetchLike = async () => {
      throw new Error('connect ETIMEDOUT');
    };
    await expect(postChatCompletion(request(rejecting))).rejects.toBeInstanceOf(AbNetworkError);
  });
});

describe('requireCodingApiKey', () => {
  it('未设 → AbAuthError', () => {
    expect(() => requireCodingApiKey({}, 'ZHIPU_CODING_API_KEY')).toThrow(AbAuthError);
    expect(() => requireCodingApiKey({ ZHIPU_CODING_API_KEY: '   ' }, 'ZHIPU_CODING_API_KEY')).toThrow(AbAuthError);
  });

  it('已设 → 返回 trim 后的 key', () => {
    expect(requireCodingApiKey({ ZHIPU_CODING_API_KEY: ' k ' }, 'ZHIPU_CODING_API_KEY')).toBe('k');
  });
});

describe('已提交 fixture 的语义（防漂移）', () => {
  it('问题集：≥6 named / ≥6 unnamed，id 唯一，named 提到 workflow、unnamed 不提', () => {
    const raw = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'workflow-background-ab-questions.json'), 'utf8'),
    ) as unknown;
    const questions = validateQuestions(raw); // 内部断言全部语义，违反即抛
    const named = questions.filter((question) => question.group === 'named');
    const unnamed = questions.filter((question) => question.group === 'unnamed');
    expect(named.length).toBeGreaterThanOrEqual(6);
    expect(unnamed.length).toBeGreaterThanOrEqual(6);
    expect(new Set(questions.map((question) => question.id)).size).toBe(questions.length);
  });

  it('系统提示：非空且不提 workflow（两臂共用的中性前缀）', () => {
    const systemPrompt = readFileSync(path.join(FIXTURES_DIR, 'workflow-background-ab-system-prompt.txt'), 'utf8');
    expect(systemPrompt.trim().length).toBeGreaterThan(0);
    expect(systemPrompt).not.toMatch(/workflow|工作流/i);
  });

  it('workflow 输入 schema fixture 的 properties/required 与源文件一致', () => {
    const fixture = JSON.parse(
      readFileSync(path.join(FIXTURES_DIR, 'workflow-background-ab-workflow-input-schema.json'), 'utf8'),
    ) as { properties: Record<string, unknown>; required: string[] };
    // 与 runner 同款的最小解析（runner 自带 main 不能被测试 import，这里按需复制）
    const source = readFileSync(SCHEMA_SOURCE_PATH, 'utf8');
    const start = source.indexOf('const workflowInputSchema = {');
    const end = source.indexOf('\n};', start);
    const block = source.slice(start, end);
    const properties = [...block.matchAll(/^ {4}([A-Za-z]+): \{$/gm)].map((match) => match[1]);
    const requiredMatch = block.match(/required: \[([^\]]*)\]/);
    expect(properties.length).toBeGreaterThan(0);
    expect(requiredMatch).not.toBeNull();
    expect(Object.keys(fixture.properties)).toEqual(properties);
    expect(fixture.required).toEqual(
      requiredMatch![1].split(',').map((item) => item.trim().replace(/^['"]|['"]$/g, '')),
    );
  });
});
