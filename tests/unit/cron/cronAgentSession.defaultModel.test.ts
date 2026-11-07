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
  // UI 当前焦点会话（getCurrentSessionId 指向它）；cron 任务不该继承它的文件夹。
  focusedSession: null as null | Record<string, unknown>,
  createSession: vi.fn(
    async (_options: { modelConfig?: unknown; [key: string]: unknown }) => ({ id: 'cron-agent-session-1' }),
  ),
}));

// createCronAgentSession 内部动态 import('../services') 建会话；只替身这两个入口。
vi.mock('../../../src/host/services', () => ({
  getSessionManager: () => ({
    getCurrentSessionId: () => (h.focusedSession ? (h.focusedSession.id as string) : null),
    getSession: async (sessionId: string) => {
      if (h.sourceSession && h.sourceSession.id === sessionId) return h.sourceSession;
      if (h.focusedSession && h.focusedSession.id === sessionId) return h.focusedSession;
      return null;
    },
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
    h.focusedSession = null;
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

  describe('working directory', () => {
    function createdWorkingDirectory(): unknown {
      const call = h.createSession.mock.calls[0]?.[0] as { workingDirectory?: unknown } | undefined;
      if (!call) throw new Error('createSession not called');
      return call.workingDirectory;
    }

    const focused = {
      id: 'focused-1',
      modelConfig: { provider: 'moonshot', model: 'kimi-k2.5' },
      workingDirectory: '/tmp/focused-chat-folder',
    };

    it('does not inherit the focused chat folder when the job has no source session', async () => {
      h.focusedSession = focused;

      await createCronAgentSession(definition(), action);

      expect(createdWorkingDirectory()).toBeUndefined();
    });

    it('still takes the focused chat model config (model fallback is unchanged)', async () => {
      h.focusedSession = focused;

      await createCronAgentSession(definition(), action);

      expect(createdModelConfig()).toMatchObject({ provider: 'moonshot', model: 'kimi-k2.5' });
    });

    it('keeps the source session folder even while another chat is focused', async () => {
      h.focusedSession = focused;
      h.sourceSession = {
        id: 'src-1',
        modelConfig: { provider: 'moonshot', model: 'kimi-k2.5' },
        workingDirectory: '/tmp/src',
      };

      await createCronAgentSession(definition('src-1'), action);

      expect(createdWorkingDirectory()).toBe('/tmp/src');
    });

    it('keeps the artifact parent folder for an artifact-refresh job with no source session', async () => {
      h.focusedSession = focused;
      const refreshDefinition: CronJobDefinition = {
        ...definition(),
        metadata: { artifactRefresh: { path: '/tmp/artifacts/report.md', instruction: 'refresh', cadence: 'daily' } },
      };

      await createCronAgentSession(refreshDefinition, action);

      expect(createdWorkingDirectory()).toBe('/tmp/artifacts');
    });
  });
});
