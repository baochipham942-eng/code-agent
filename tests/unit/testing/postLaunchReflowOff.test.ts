// privacy.postLaunchReflow 关着时与回流合并前一字不差（#1686）。
// 两种关法：显式 'off'、外部槽 'auto'。候选 IPC 返空、回流 HARVEST_PREVIEW 拒、
// SAVE_CASE 不带 postLaunchReflow 参数时原样交给题库、不走回流闸。
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';

process.env.CODE_AGENT_DATA_DIR = path.join(os.tmpdir(), `postlaunch-reflow-off-${process.pid}`);

vi.unmock('better-sqlite3');

import { POST_LAUNCH_REFLOW_DISABLED_MESSAGE } from '../../../src/shared/contract/postLaunchScore';
import { CONFIG_DIR_DEV, CONFIG_DIR_NEW } from '../../../src/shared/constants/configDir';
import { TELEMETRY_CHANNELS } from '../../../src/shared/ipc/channels';
import { EVALUATION_CHANNELS } from '@internal-evaluation/shared/evaluationChannels';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { applyTelemetrySchema } from '../../../src/host/services/core/database/schemaTelemetry';
import { insertTurnScore, setPostLaunchConsentScope } from '../../../src/host/testing/postlaunch/postLaunchScoreStore';
import type { IpcMain } from '../../../src/host/platform';

const INTERNAL_SLOT_DIR = path.join('/tmp', CONFIG_DIR_DEV);
const EXTERNAL_DIR = path.join('/tmp', CONFIG_DIR_NEW);

const env = vi.hoisted(() => ({
  logger: { debug() {}, info() {}, warn() {}, error() {} } as never,
  getSettings: vi.fn(),
  getUserDataPath: vi.fn(),
  getDb: vi.fn(),
  getSession: vi.fn(),
  replay: vi.fn(),
  saveCase: vi.fn(async (root: string, payload: unknown) => ({ action: 'create-draft', id: 'draft-1', file: 'drafts/draft-1.yaml', root, payload })),
  telemetryHandlers: new Map<string, (...args: unknown[]) => unknown>(),
}));

vi.mock('../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getSettings: env.getSettings }),
}));

vi.mock('../../../src/host/platform', () => ({
  ipcHost: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => {
      env.telemetryHandlers.set(channel, handler);
    },
  },
  AppWindow: {},
  getUserDataPath: () => env.getUserDataPath(),
}));

vi.mock('../../../src/host/ipc/adminGuard', () => ({
  assertAdminAccess: () => undefined,
  isCurrentUserAdmin: () => true,
  getAdminAccessIpcError: () => null,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => env.logger,
}));

vi.mock('../../../src/host/telemetry/telemetryStorage', () => ({
  getTelemetryStorage: () => ({
    getSession: vi.fn(),
    listSessions: vi.fn(),
    getTurnsBySession: vi.fn(),
    getEventsBySession: vi.fn(),
    deleteSession: vi.fn(),
  }),
}));

vi.mock('../../../src/host/telemetry/telemetryCollector', () => ({
  getTelemetryCollector: () => ({ addEventListener: vi.fn() }),
}));

vi.mock('../../../src/host/telemetry/telemetryUploaderService', () => ({
  getTelemetryUploaderService: () => ({}),
}));

vi.mock('../../../src/host/telemetry/telemetryFeedbackSql', () => ({
  getSessionFeedbackRatings: vi.fn(),
}));

vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: env.getDb, getSession: env.getSession }),
}));

vi.mock('@host/services/core/databaseService', () => ({
  getDatabase: () => ({ getDb: env.getDb, getSession: env.getSession }),
}));

vi.mock('@host/telemetry/replay/telemetryQueryService', () => ({
  getTelemetryQueryService: () => ({ getStructuredReplay: env.replay }),
}));

vi.mock('@internal-evaluation/host/evaluation/evalEnvironment', () => ({
  inspectEvalEnvironment: () => ({ repositoryRoot: '/repo' }),
}));

vi.mock('@internal-evaluation/host/testing/caseBank', () => ({
  enumerateCaseBank: vi.fn(),
  saveCaseBank: env.saveCase,
}));

vi.mock('@internal-evaluation/host/evaluation/evalRunPanelProbe', () => ({
  inspectEvalRunPanel: vi.fn(),
}));

vi.mock('@internal-evaluation/host/evaluation/evalRunBridge', () => ({
  getEvalRunBridge: () => ({ startRun: vi.fn(), subscribe: vi.fn(), abortRun: vi.fn() }),
}));

vi.mock('../../../src/host/services/auth/authService', () => ({
  getAuthService: () => ({ getCurrentUser: () => ({ id: 'host-reviewer' }) }),
}));

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db, env.logger);
  applyTelemetrySchema(db, env.logger);
  insertTurnScore(db, {
    sessionId: 'live-session',
    turnId: 'live-turn',
    scoredAt: 50,
    scoredDay: '2026-09-07',
    appVersion: '0.33.0',
    promptVersion: null,
    judgeVersion: 'postlaunch-judge-v1',
    rubricVersion: 'postlaunch-rubric-v1',
    judgeModel: 'm',
    promptHash: 'h',
    dims: { goal: 0, orchestration: 1, tools: 1, permission: 1, safety: 1, artifact: 1 },
    failureClass: null,
    reasonRedacted: '',
    redacted: false,
    signals: [],
    costUsd: 0,
    budgetCostUsd: 0,
    sampledBy: 'signal',
  }, 50);
  return db;
}

const SAVE_PAYLOAD = {
  action: 'create-draft' as const,
  id: 'draft-plain',
  prompt: '原样题面',
  tags: ['harvest-0907'],
};

describe.each([
  { name: "显式 off", setting: 'off' as const, dataDir: INTERNAL_SLOT_DIR },
  { name: "外部槽 auto", setting: 'auto' as const, dataDir: EXTERNAL_DIR },
])('privacy.postLaunchReflow $name 时与改前一字不差', ({ setting, dataDir }) => {
  beforeEach(() => {
    env.getSettings.mockReset();
    env.getUserDataPath.mockReset();
    env.getDb.mockReset();
    env.getSession.mockReset();
    env.replay.mockReset();
    env.saveCase.mockClear();
    env.telemetryHandlers.clear();
    env.getSettings.mockReturnValue({ privacy: { postLaunchReflow: setting } });
    env.getUserDataPath.mockReturnValue(dataDir);
    env.getDb.mockReturnValue(makeDb());
    env.getSession.mockReturnValue({ title: '一场会话', workingDirectory: '/tmp/ws' });
    env.replay.mockResolvedValue(null);
  });

  it('候选 IPC 返空，不把库里已有的红分会话带出去', async () => {
    const { registerTelemetryHandlers } = await import('../../../src/host/ipc/telemetry.ipc');
    registerTelemetryHandlers(() => null);
    const handler = env.telemetryHandlers.get(TELEMETRY_CHANNELS.GET_POSTLAUNCH_REFLOW_CANDIDATES);
    expect(handler).toBeTypeOf('function');
    await expect(handler!(null, { limit: 200 })).resolves.toEqual([]);
  });

  it('回流 HARVEST_PREVIEW 拒', async () => {
    const { buildHarvestPreview } = await import('@internal-evaluation/host/evaluation/harvestPreview');
    await expect(buildHarvestPreview({
      sessionIds: ['live-session'],
      fields: ['prompt'],
      postLaunchReflow: true,
    })).rejects.toThrow(/上线后坏案例回流没开/);
  });

  it('SAVE_CASE 不带 postLaunchReflow 参数时原样保存，不走回流闸', async () => {
    const { registerEvaluationHandlers } = await import('@internal-evaluation/host/ipc/evaluation.ipc');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    };
    registerEvaluationHandlers(ipcMain as unknown as IpcMain);
    const result = await handlers.get(EVALUATION_CHANNELS.SAVE_CASE)!(null, SAVE_PAYLOAD);
    expect(result).toMatchObject({ action: 'create-draft', id: 'draft-1' });
    expect(env.saveCase).toHaveBeenCalledTimes(1);
    expect(env.saveCase.mock.calls[0]?.[0]).toBe('/repo');
    expect(env.saveCase.mock.calls[0]?.[1]).toEqual(SAVE_PAYLOAD);
    expect(env.saveCase.mock.calls[0]?.[1]).not.toHaveProperty('postLaunchReflow');
  });

  it('不带 postLaunchReflow 的 HARVEST_PREVIEW 不走回流拒门', async () => {
    const { buildHarvestPreview } = await import('@internal-evaluation/host/evaluation/harvestPreview');
    const result = await buildHarvestPreview({ sessionIds: ['live-session'], fields: ['prompt'] });
    expect(result.failed).toEqual([{ sessionId: 'live-session', error: '这场会话没有可回放的记录' }]);
    expect(result.seeds).toEqual([]);
  });
});

describe('回流开关三态本身', () => {
  it("off 与外部槽 auto 为关，on 与内部槽 auto 为开", async () => {
    const { resolvePostLaunchReflowEnabled } = await import('../../../src/shared/contract/postLaunchScore');
    expect(resolvePostLaunchReflowEnabled('off', true)).toBe(false);
    expect(resolvePostLaunchReflowEnabled('auto', false)).toBe(false);
    expect(resolvePostLaunchReflowEnabled('on', false)).toBe(true);
    expect(resolvePostLaunchReflowEnabled('auto', true)).toBe(true);
  });

  it('带 postLaunchReflow 的 SAVE_CASE 在关着时拒', async () => {
    env.saveCase.mockClear();
    env.getSettings.mockReturnValue({ privacy: { postLaunchReflow: 'off' } });
    env.getUserDataPath.mockReturnValue(INTERNAL_SLOT_DIR);
    const { registerEvaluationHandlers } = await import('@internal-evaluation/host/ipc/evaluation.ipc');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    };
    registerEvaluationHandlers(ipcMain as unknown as IpcMain);
    await expect(handlers.get(EVALUATION_CHANNELS.SAVE_CASE)!(null, {
      ...SAVE_PAYLOAD,
      sourceSessionId: 'live-session',
      postLaunchReflow: { turnId: 'live-turn', sources: ['judge'] },
    })).rejects.toThrow(POST_LAUNCH_REFLOW_DISABLED_MESSAGE);
    expect(env.saveCase).not.toHaveBeenCalled();
  });
});

describe('回流 SAVE_CASE 绑定预览同意档', () => {
  async function saveCase(payload: Record<string, unknown>) {
    const { registerEvaluationHandlers } = await import('@internal-evaluation/host/ipc/evaluation.ipc');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler)),
    };
    registerEvaluationHandlers(ipcMain as unknown as IpcMain);
    return handlers.get(EVALUATION_CHANNELS.SAVE_CASE)!(null, payload);
  }

  const reflowPayload = {
    ...SAVE_PAYLOAD,
    sourceSessionId: 'live-session',
    postLaunchReflow: { turnId: 'live-turn', sources: ['judge'] as Array<'judge'>, consentScope: 'full_session' as const },
  };

  beforeEach(() => {
    env.getSettings.mockReset();
    env.getUserDataPath.mockReset();
    env.getDb.mockReset();
    env.saveCase.mockClear();
    env.getSettings.mockReturnValue({ privacy: { postLaunchReflow: 'on' } });
    env.getUserDataPath.mockReturnValue(INTERNAL_SLOT_DIR);
    env.getDb.mockReturnValue(makeDb());
  });

  it('full_session 预览后降到 turn_excerpt/metadata 时拒存，档不变或升高时放行', async () => {
    const db = env.getDb() as Database.Database;
    setPostLaunchConsentScope(db, 'live-session', 'full_session', 20);
    await expect(saveCase(reflowPayload)).resolves.toMatchObject({ action: 'create-draft', id: 'draft-1' });
    expect(env.saveCase).toHaveBeenCalledTimes(1);

    env.saveCase.mockClear();
    setPostLaunchConsentScope(db, 'live-session', 'turn_excerpt', 21);
    await expect(saveCase(reflowPayload)).rejects.toThrow(/低于预览所用档，请重新生成/);
    expect(env.saveCase).not.toHaveBeenCalled();

    setPostLaunchConsentScope(db, 'live-session', 'metadata', 22);
    await expect(saveCase(reflowPayload)).rejects.toThrow(/至少需要 turn_excerpt/);
    expect(env.saveCase).not.toHaveBeenCalled();

    setPostLaunchConsentScope(db, 'live-session', 'turn_excerpt', 23);
    await expect(saveCase({
      ...reflowPayload,
      postLaunchReflow: { ...reflowPayload.postLaunchReflow, consentScope: 'turn_excerpt' },
    })).resolves.toMatchObject({ action: 'create-draft', id: 'draft-1' });

    env.saveCase.mockClear();
    setPostLaunchConsentScope(db, 'live-session', 'full_session', 24);
    await expect(saveCase({
      ...reflowPayload,
      postLaunchReflow: { ...reflowPayload.postLaunchReflow, consentScope: 'turn_excerpt' },
    })).resolves.toMatchObject({ action: 'create-draft', id: 'draft-1' });
  });

  it('旧预览没带同意档时拒存并要求重新生成', async () => {
    const db = env.getDb() as Database.Database;
    setPostLaunchConsentScope(db, 'live-session', 'full_session', 20);
    await expect(saveCase({
      ...reflowPayload,
      postLaunchReflow: { turnId: 'live-turn', sources: ['judge'] },
    })).rejects.toThrow(/预览同意档缺失，请重新生成/);
    expect(env.saveCase).not.toHaveBeenCalled();
  });
});
