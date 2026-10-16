// ============================================================================
// Skill × managed Python gate — N-PY-RUNTIME-K2
//
// bins 含 python3 的 skill 在分发前等待托管解释器就绪：按需安装（ensurePythonEnv
// 恰好一次）、可中止（AbortSignal）、进度经 onProgress 透传。ensure/state 打桩
// （真装走网络）；非 python skill 不得触发安装。
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import type { ParsedSkill } from '../../../../../src/shared/contract/agentSkill';
import type {
  EnsurePythonEnvResult,
  PythonEnvState,
} from '../../../../../src/host/runtime/pythonEnv/types';

// -----------------------------------------------------------------------------
// Mocks：registry + 兄弟 helper（与 skill.test.ts 同构）+ pythonEnv ensure/state
// -----------------------------------------------------------------------------

const ensureInitializedMock = vi.fn(async (_dir: string) => {});
const getSkillMock = vi.fn<(name: string) => ParsedSkill | undefined>();
const getAllSkillsMock = vi.fn<() => ParsedSkill[]>();
const isSkillEnabledMock = vi.fn<(name: string) => boolean>(() => true);

vi.mock('../../../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () => ({
    ensureInitialized: ensureInitializedMock,
    getSkill: getSkillMock,
    getAllSkills: getAllSkillsMock,
    getWorkingDirectory: () => '/test/wd',
    isSkillEnabled: isSkillEnabledMock,
    isInitialized: () => true,
  }),
}));

const loadSkillContentMock = vi.fn(async (_skill: ParsedSkill) => {});
vi.mock('../../../../../src/host/services/skills/skillLoader', () => ({
  loadSkillContent: (skill: ParsedSkill) => loadSkillContentMock(skill),
}));

vi.mock('../../../../../src/host/services/skills/skillUsageTracker', () => ({
  recordSkillUsage: vi.fn(async () => {}),
}));

vi.mock('../../../../../src/host/services/skills/distillSignalStore', () => ({
  markDistilledSkillTurnSignal: vi.fn(() => true),
}));

vi.mock('../../../../../src/host/services/skills/skillRenderer', () => ({
  renderSkillContent: (content: string) => content,
}));

vi.mock('../../../../../src/host/runtime/pythonEnv/ensure', () => ({
  ensurePythonEnv: vi.fn(),
}));

vi.mock('../../../../../src/host/runtime/pythonEnv/state', () => ({
  getPythonEnvState: vi.fn(),
}));

import { ensurePythonEnv } from '../../../../../src/host/runtime/pythonEnv/ensure';
import { getPythonEnvState } from '../../../../../src/host/runtime/pythonEnv/state';
import { skillModule } from '../../../../../src/host/tools/modules/skill/skill';

const ensurePythonEnvMock = vi.mocked(ensurePythonEnv);
const getPythonEnvStateMock = vi.mocked(getPythonEnvState);

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/test/wd',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    resolver: { getDefinition: vi.fn() },
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true, reason: '' });

function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: 'data-demo',
    description: 'demo skill',
    promptContent: 'do the thing',
    basePath: '/skills/data-demo',
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    loaded: true,
    ...overrides,
  };
}

function stateOf(phase: PythonEnvState['phase'], extra: Partial<PythonEnvState> = {}): PythonEnvState {
  return { phase, root: '/data/runtimes/python', pythonPath: null, ...extra };
}

function ensureOk(): EnsurePythonEnvResult {
  return { ok: true, pythonPath: '/data/runtimes/python/venv/bin/python', reused: false, root: '/data/runtimes/python' };
}

beforeEach(() => {
  ensureInitializedMock.mockReset();
  ensureInitializedMock.mockImplementation(async () => {});
  getSkillMock.mockReset();
  getAllSkillsMock.mockReset();
  getAllSkillsMock.mockReturnValue([]);
  isSkillEnabledMock.mockReset();
  isSkillEnabledMock.mockReturnValue(true);
  loadSkillContentMock.mockReset();
  loadSkillContentMock.mockImplementation(async () => {});
  ensurePythonEnvMock.mockReset();
  getPythonEnvStateMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('skill tool × managed python gate', () => {
  it('python3 skill awaits ensurePythonEnv exactly once, then runs', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('missing'));
    ensurePythonEnvMock.mockResolvedValue(ensureOk());
    const handler = await skillModule.createHandler();
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll);
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('activated');
  });

  it('already installed ⇒ ensure never called', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('installed', { pythonPath: '/data/runtimes/python/venv/bin/python' }));
    const handler = await skillModule.createHandler();
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll);
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('ensure resolves K1 failure ⇒ structured error with the K1 code, skill not dispatched', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('missing'));
    ensurePythonEnvMock.mockResolvedValue({
      ok: false,
      root: '/data/runtimes/python',
      error: {
        code: 'PYTHON_RUNTIME_OFFLINE',
        message: 'Python runtime install needs a package index, but both PyPI and the mirror are unreachable.',
        retryable: true,
        logPath: '/data/runtimes/python/install.log',
      },
    });
    const handler = await skillModule.createHandler();
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PYTHON_RUNTIME_OFFLINE');
      expect(result.error).toContain('unreachable');
      expect(result.error).toContain('re-run');
    }
  });

  it('non-python skill ⇒ ensure never called', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['git'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('missing'));
    const handler = await skillModule.createHandler();
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll);
    expect(ensurePythonEnvMock).not.toHaveBeenCalled();
    expect(result.ok).toBe(true);
  });

  it('fork-mode python3 skill also passes through the gate before dispatch', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'], executionContext: 'fork' }));
    getPythonEnvStateMock.mockReturnValue(stateOf('missing'));
    ensurePythonEnvMock.mockResolvedValue(ensureOk());
    const handler = await skillModule.createHandler();
    // 无 modelConfig → fork 分发固有的 NOT_INITIALIZED；闸门在此之前已等待过 ensure
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll);
    expect(ensurePythonEnvMock).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
  });

  it('abort while installing ⇒ ABORTED propagates without waiting for the install', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('missing'));
    ensurePythonEnvMock.mockReturnValue(new Promise<EnsurePythonEnvResult>(() => {}));
    const ctrl = new AbortController();
    const ctx = makeCtx({ abortSignal: ctrl.signal });
    const handler = await skillModule.createHandler();
    const pending = handler.execute({ command: 'data-demo' }, ctx, allowAll);
    await Promise.resolve();
    ctrl.abort();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('ABORTED');
  });

  it('install progress flows through onProgress', async () => {
    getSkillMock.mockReturnValue(makeSkill({ bins: ['python3'] }));
    getPythonEnvStateMock.mockReturnValue(stateOf('installing', { percent: 42 }));
    ensurePythonEnvMock.mockResolvedValue(ensureOk());
    const onProgress = vi.fn();
    const handler = await skillModule.createHandler();
    const result = await handler.execute({ command: 'data-demo' }, makeCtx(), allowAll, onProgress);
    expect(result.ok).toBe(true);
    expect(onProgress).toHaveBeenCalledWith(expect.objectContaining({ percent: 42 }));
  });
});
