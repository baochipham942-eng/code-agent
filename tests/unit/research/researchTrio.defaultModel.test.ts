// 深度研究三件套（planner / executor / generator）的默认模型解析：
// 显式 config.* 仍最高优先；未传时走 resolveSessionDefaultModelConfig——
// 用户配置的 models.default 优先，未配置才落出厂默认。真模型不真发，
// ModelRouter 由构造注入替身，只断言 chat 收到的 provider/model。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModelRouter } from '../../../src/host/model/modelRouter';
import type { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { ResearchPlan, ResearchStep } from '../../../src/host/research/types';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string }>,
    },
  },
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

import { ResearchPlanner } from '../../../src/host/research/researchPlanner';
import { ReportGenerator } from '../../../src/host/research/reportGenerator';
import { ResearchExecutor } from '../../../src/host/research/researchExecutor';

function chatStub() {
  return { chat: vi.fn(async (_request: unknown) => ({ content: '{}', finishReason: 'stop' as const })) };
}

function chatCalls(stub: ReturnType<typeof chatStub>) {
  return stub.chat.mock.calls;
}

function analysisStep(id: string): ResearchStep {
  return {
    id,
    title: `分析${id}`,
    description: 'd',
    stepType: 'analysis',
    status: 'pending',
  };
}

/** executor 用：两个 pending analysis 步骤——第一个跑完落结果喂给第二个，
 *  第二个真触发 analysis chat；executeWithReflection 再补一次 reflection chat。 */
function executorPlan(): ResearchPlan {
  return {
    topic: 't',
    clarifiedTopic: 't',
    objectives: [],
    steps: [analysisStep('1'), analysisStep('2')],
    expectedOutput: '',
    createdAt: 1,
  };
}

/** generator 用：只要 completed 步骤带结果，generate 才会真调 chat。 */
function reportPlan(): ResearchPlan {
  return {
    topic: 't',
    clarifiedTopic: 't',
    objectives: [],
    steps: [{ ...analysisStep('1'), status: 'completed', result: '已有分析结论' }],
    expectedOutput: '',
    createdAt: 1,
  };
}

function configureUserDefault() {
  h.settings.models.default = 'deepseek';
  h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };
}

describe('deep research default model (planner / executor / generator)', () => {
  beforeEach(() => {
    h.settings.models.default = '';
    h.settings.models.providers = {};
  });

  it('planner plans on the configured user provider and model', async () => {
    configureUserDefault();
    const chat = chatStub();
    await new ResearchPlanner(chat as unknown as ModelRouter).createPlan('量子计算进展');

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('planner keeps explicit config.* ahead of the user default', async () => {
    configureUserDefault();
    const chat = chatStub();
    await new ResearchPlanner(chat as unknown as ModelRouter).createPlan('量子计算进展', {
      modelProvider: 'zhipu',
      model: 'glm-5.3',
    });

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: 'zhipu', model: 'glm-5.3' });
  });

  it('planner falls back to the factory default when nothing is configured', async () => {
    const chat = chatStub();
    await new ResearchPlanner(chat as unknown as ModelRouter).createPlan('量子计算进展');

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat });
  });

  it('executor analyzes and reflects on the configured user provider and model', async () => {
    configureUserDefault();
    const chat = chatStub();
    const executor = new ResearchExecutor(
      {} as ToolExecutor,
      chat as unknown as ModelRouter,
      undefined,
      { enableStepParallelism: false },
    );

    await executor.executeWithReflection(executorPlan(), {});

    expect(chatCalls(chat).length).toBeGreaterThanOrEqual(2); // analysis + reflection
    for (const call of chatCalls(chat)) {
      expect(call[0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
    }
  });

  it('executor falls back to the factory default when nothing is configured', async () => {
    const chat = chatStub();
    const executor = new ResearchExecutor(
      {} as ToolExecutor,
      chat as unknown as ModelRouter,
      undefined,
      { enableStepParallelism: false },
    );

    await executor.executeWithReflection(executorPlan(), {});

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat });
  });

  it('generator reports on the configured user provider and model', async () => {
    configureUserDefault();
    const chat = chatStub();
    await new ReportGenerator(chat as unknown as ModelRouter).generate(reportPlan(), 'default');

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('generator falls back to the factory default when nothing is configured', async () => {
    const chat = chatStub();
    await new ReportGenerator(chat as unknown as ModelRouter).generate(reportPlan(), 'default');

    expect(chatCalls(chat)[0][0]).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat });
  });
});
