// cron 会话默认模型：来源/当前会话模型 → settings 默认模型 → 出厂默认。
// 死掉的 settings.model 项已移除；用户在设置里配的 models.default 必须生效。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CronJobAction, CronJobDefinition } from '../../../src/shared/contract/cron';
import { DEFAULT_MODELS, DEFAULT_PROVIDER } from '../../../src/shared/constants';

const h = vi.hoisted(() => ({
  settings: {
    models: {
      default: '' as string,
      providers: {} as Record<string, { model?: string; baseUrl?: string }>,
    },
  },
  sourceSession: null as null | Record<string, unknown>,
  createSession: vi.fn(
    async (_options: { modelConfig?: unknown; [key: string]: unknown }) => ({ id: 'cron-agent-session-1' }),
  ),
}));

// createCronAgentSession 内部动态 import('../services') 建会话；只替身这两个入口。
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => null,
    getSession: async (sessionId: string) => (
      h.sourceSession && h.sourceSession.id === sessionId ? h.sourceSession : null
    ),
    createSession: h.createSession,
  }),
}));

// resolveSessionDefaultModelConfig 内部走深路径 getConfigService。
vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => h.settings,
    getApiKey: () => '',
  }),
}));

import { createCronAgentSession } from '../../../src/host/cron/cronAgentSession';

function definition(sourceSessionId?: string): CronJobDefinition {
  return {
    id: 'job-1',
    name: '每日巡检',
    scheduleType: 'cron',
    schedule: { type: 'cron', expression: '0 9 * * *' } as CronJobDefinition['schedule'],
    action: { type: 'shell', command: 'echo hi' },
    runsOn: 'local',
    enabled: true,
    createdAt: 1,
    updatedAt: 1,
    ...(sourceSessionId ? { metadata: { sourceSessionId } } : {}),
  };
}

const action: CronJobAction = { type: 'shell', command: 'echo hi' };

function createdModelConfig(): Record<string, unknown> {
  const call = h.createSession.mock.calls[0]?.[0] as { modelConfig?: Record<string, unknown> } | undefined;
  if (!call?.modelConfig) throw new Error('createSession not called with modelConfig');
  return call.modelConfig;
}

describe('createCronAgentSession default model', () => {
  beforeEach(() => {
    h.createSession.mockClear();
    h.settings.models.default = '';
    h.settings.models.providers = {};
    h.sourceSession = null;
  });

  it('resolves the cron session modelConfig from the configured default provider', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };

    await createCronAgentSession(definition(), action);

    expect(createdModelConfig()).toMatchObject({ provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('keeps the source session modelConfig ahead of the configured default', async () => {
    h.settings.models.default = 'deepseek';
    h.settings.models.providers = { deepseek: { model: 'deepseek-chat' } };
    h.sourceSession = {
      id: 'src-1',
      modelConfig: { provider: 'moonshot', model: 'kimi-k2.5', temperature: 0.2, maxTokens: 4096 },
      workingDirectory: '/tmp/src',
    };

    await createCronAgentSession(definition('src-1'), action);

    expect(createdModelConfig()).toMatchObject({
      provider: 'moonshot',
      model: 'kimi-k2.5',
      temperature: 0.2,
      maxTokens: 4096,
    });
  });

  it('falls back to the factory default when nothing is configured', async () => {
    await createCronAgentSession(definition(), action);

    expect(createdModelConfig()).toMatchObject({ provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat });
  });
});
