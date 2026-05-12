// ============================================================================
// Skill (native ToolModule) Tests — P0-6.x Wave 1
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';
import type { ParsedSkill } from '../../../../../src/shared/contract/agentSkill';

// -----------------------------------------------------------------------------
// Mock skill registry (getSkillDiscoveryService) + sibling helpers
// -----------------------------------------------------------------------------

const ensureInitializedMock = vi.fn(async (_dir: string) => {});
const getSkillMock = vi.fn<(name: string) => ParsedSkill | undefined>();
const getAllSkillsMock = vi.fn<() => ParsedSkill[]>();
const getSkillsForContextMock = vi.fn<() => ParsedSkill[]>();
const getWorkingDirectoryMock = vi.fn<() => string>(() => '/test/wd');

let registryAvailable = true;

vi.mock('../../../../../src/main/services/skills', () => ({
  getSkillDiscoveryService: () =>
    registryAvailable
      ? {
          ensureInitialized: ensureInitializedMock,
          getSkill: getSkillMock,
          getAllSkills: getAllSkillsMock,
          getSkillsForContext: getSkillsForContextMock,
          getWorkingDirectory: getWorkingDirectoryMock,
          isInitialized: () => true,
        }
      : undefined,
}));

const loadSkillContentMock = vi.fn(async (_skill: ParsedSkill) => {});
vi.mock('../../../../../src/main/services/skills/skillLoader', () => ({
  loadSkillContent: (skill: ParsedSkill) => loadSkillContentMock(skill),
}));

const recordSkillUsageMock = vi.fn(() => {});
vi.mock('../../../../../src/main/services/skills/skillUsageTracker', () => ({
  recordSkillUsage: (...args: unknown[]) => recordSkillUsageMock(...args),
}));

const renderSkillContentMock = vi.fn(
  (content: string, _opts: { arguments?: string; workingDirectory?: string }) => content,
);
vi.mock('../../../../../src/main/services/skills/skillRenderer', () => ({
  renderSkillContent: (...args: Parameters<typeof renderSkillContentMock>) =>
    renderSkillContentMock(...args),
}));

const subagentExecuteMock = vi.fn();
vi.mock('../../../../../src/main/agent/subagentExecutor', () => ({
  getSubagentExecutor: () => ({ execute: subagentExecuteMock }),
}));

vi.mock('../../../../../src/main/tools/workbenchToolScope', () => ({
  isSkillCommandAllowedByWorkbenchScope: (
    command: string,
    scope: { skills?: string[] } | undefined,
  ) => {
    if (!scope || !scope.skills) return true;
    return scope.skills.includes(command);
  },
}));

import { skillModule } from '../../../../../src/main/tools/modules/skill/skill';

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
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

async function run(
  args: Record<string, unknown>,
  ctx: ToolContext = makeCtx(),
  canUseTool: CanUseToolFn = allowAll,
  onProgress?: (p: { stage: string }) => void,
) {
  const handler = await skillModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

function makeSkill(overrides: Partial<ParsedSkill> = {}): ParsedSkill {
  return {
    name: 'demo',
    description: 'demo skill',
    promptContent: 'do the thing',
    basePath: '/skills/demo',
    allowedTools: [],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'user',
    loaded: true,
    ...overrides,
  };
}

beforeEach(() => {
  registryAvailable = true;
  ensureInitializedMock.mockReset();
  ensureInitializedMock.mockImplementation(async () => {});
  getSkillMock.mockReset();
  getAllSkillsMock.mockReset();
  getAllSkillsMock.mockReturnValue([]);
  getSkillsForContextMock.mockReset();
  getSkillsForContextMock.mockReturnValue([]);
  getWorkingDirectoryMock.mockReset();
  getWorkingDirectoryMock.mockReturnValue('/test/wd');
  loadSkillContentMock.mockReset();
  loadSkillContentMock.mockImplementation(async () => {});
  recordSkillUsageMock.mockReset();
  renderSkillContentMock.mockReset();
  renderSkillContentMock.mockImplementation((content) => content);
  subagentExecuteMock.mockReset();
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('skillModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(skillModule.schema.name).toBe('Skill');
      expect(skillModule.schema.category).toBe('skill');
      expect(skillModule.schema.permissionLevel).toBe('read');
      expect(skillModule.schema.readOnly).toBe(false);
      expect(skillModule.schema.allowInPlanMode).toBe(false);
      expect(skillModule.schema.inputSchema.required).toEqual(['command']);
      expect(skillModule.schema.inputSchema.properties).toHaveProperty('command');
      expect(skillModule.schema.inputSchema.properties).toHaveProperty('args');
    });
  });

  describe('validation & errors', () => {
    it('rejects missing command', async () => {
      const result = await run({});
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects non-string command', async () => {
      const result = await run({ command: 123 });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run({ command: 'demo' }, makeCtx(), denyAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal pre-aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run({ command: 'demo' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when registry unavailable', async () => {
      registryAvailable = false;
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('returns NOT_INITIALIZED when ensureInitialized throws', async () => {
      ensureInitializedMock.mockRejectedValue(new Error('init boom'));
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('init boom');
      }
    });

    it('returns INVALID_ARGS for unknown skill, listing available names', async () => {
      getSkillMock.mockReturnValue(undefined);
      getAllSkillsMock.mockReturnValue([
        makeSkill({ name: 'a' }),
        makeSkill({ name: 'b' }),
      ]);
      const result = await run({ command: 'missing' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('Unknown skill: missing');
        expect(result.error).toContain('a, b');
      }
    });

    it('returns WORKBENCH_SCOPE_DENIED when skill blocked by scope', async () => {
      getSkillMock.mockReturnValue(makeSkill({ name: 'blocked' }));
      const ctx = makeCtx({ toolScope: { skills: ['other'] } as never });
      const result = await run({ command: 'blocked' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('WORKBENCH_SCOPE_DENIED');
        expect(result.error).toContain('blocked');
      }
    });
  });

  describe('inline execution happy path', () => {
    it('returns activation result + skillResult meta', async () => {
      const skill = makeSkill({ name: 'demo' });
      getSkillMock.mockReturnValue(skill);

      const result = await run({ command: 'demo', args: 'foo bar' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Skill "demo" activated');
        expect(result.meta).toBeDefined();
        const meta = result.meta as { isSkillActivation: boolean; skillResult: { newMessages: Array<{ content: string; isMeta: boolean }> } };
        expect(meta.isSkillActivation).toBe(true);
        expect(meta.skillResult.newMessages).toHaveLength(2);
        expect(meta.skillResult.newMessages[0].isMeta).toBe(false);
        expect(meta.skillResult.newMessages[0].content).toContain('Loading skill: demo');
        expect(meta.skillResult.newMessages[1].isMeta).toBe(true);
        expect(meta.skillResult.newMessages[1].content).toContain('User provided arguments: foo bar');
        expect(result.meta).toMatchObject({
          command: 'demo',
          skillName: 'demo',
          source: 'user',
          executionContext: 'inline',
          isSkillActivation: true,
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.metadata?.skillName).toBe('demo');
      }
    });

    it('appends self-patching hint for user/project skills', async () => {
      getSkillMock.mockReturnValue(makeSkill({ name: 'demo', source: 'user', basePath: '/u/demo' }));
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as { skillResult: { newMessages: Array<{ content: string }> } };
        expect(meta.skillResult.newMessages[1].content).toContain('自修补');
        expect(meta.skillResult.newMessages[1].content).toContain('/u/demo/SKILL.md');
      }
    });

    it('does not append self-patching hint for builtin skills', async () => {
      getSkillMock.mockReturnValue(makeSkill({ name: 'demo', source: 'builtin' }));
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as { skillResult: { newMessages: Array<{ content: string }> } };
        expect(meta.skillResult.newMessages[1].content).not.toContain('自修补');
      }
    });

    it('pre-approves tools only for builtin/plugin skills', async () => {
      getSkillMock.mockReturnValue(
        makeSkill({ name: 'demo', source: 'plugin', allowedTools: ['Read', 'Write'] }),
      );
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as { skillResult: { contextModifier: { preApprovedTools?: string[] } } };
        expect(meta.skillResult.contextModifier.preApprovedTools).toEqual(['Read', 'Write']);
      }
    });

    it('does NOT pre-approve tools for cloud skills', async () => {
      getSkillMock.mockReturnValue(
        makeSkill({ name: 'demo', source: 'cloud', allowedTools: ['Read', 'Write'] }),
      );
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as { skillResult: { contextModifier: { preApprovedTools?: string[] } } };
        expect(meta.skillResult.contextModifier.preApprovedTools).toBeUndefined();
      }
    });

    it('does NOT pre-approve tools for user skills (security boundary)', async () => {
      getSkillMock.mockReturnValue(
        makeSkill({ name: 'demo', source: 'user', allowedTools: ['Read', 'Write'] }),
      );
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const meta = result.meta as { skillResult: { contextModifier: { preApprovedTools?: string[] } } };
        expect(meta.skillResult.contextModifier.preApprovedTools).toBeUndefined();
      }
    });

    it('lazy loads content when skill not loaded', async () => {
      const skill = makeSkill({ name: 'demo', loaded: false });
      getSkillMock.mockReturnValue(skill);
      await run({ command: 'demo' });
      expect(loadSkillContentMock).toHaveBeenCalledWith(skill);
    });
  });

  describe('fork execution', () => {
    it('returns NOT_INITIALIZED when modelConfig missing', async () => {
      getSkillMock.mockReturnValue(makeSkill({ executionContext: 'fork' }));
      const result = await run({ command: 'demo' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('NOT_INITIALIZED');
        expect(result.error).toContain('Subagent context not available');
      }
    });

    it('returns success output when subagent finishes', async () => {
      getSkillMock.mockReturnValue(makeSkill({ executionContext: 'fork', name: 'demo' }));
      subagentExecuteMock.mockResolvedValue({
        success: true,
        iterations: 3,
        toolsUsed: ['Read', 'Write'],
        output: 'task done',
      });
      const ctx = makeCtx({ modelConfig: {} as never });
      const result = await run({ command: 'demo' }, ctx);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Skill "demo" completed');
        expect(result.output).toContain('Iterations: 3');
        expect(result.output).toContain('Tools used: Read, Write');
        expect(result.output).toContain('task done');
        expect(result.meta).toMatchObject({
          command: 'demo',
          skillName: 'demo',
          executionContext: 'fork',
          iterations: 3,
          toolsUsed: ['Read', 'Write'],
        });
        const artifact = result.meta?.artifact as { kind?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('process-output');
        expect(artifact.metadata?.iterations).toBe(3);
      }
    });

    it('returns error result on subagent failure', async () => {
      getSkillMock.mockReturnValue(makeSkill({ executionContext: 'fork', name: 'demo' }));
      subagentExecuteMock.mockResolvedValue({
        success: false,
        error: 'tool blew up',
        output: 'partial',
        iterations: 1,
        toolsUsed: [],
      });
      const ctx = makeCtx({ modelConfig: {} as never });
      const result = await run({ command: 'demo' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('Skill "demo" failed: tool blew up');
      }
    });

    it('catches thrown subagent errors', async () => {
      getSkillMock.mockReturnValue(makeSkill({ executionContext: 'fork', name: 'demo' }));
      subagentExecuteMock.mockRejectedValue(new Error('boom'));
      const ctx = makeCtx({ modelConfig: {} as never });
      const result = await run({ command: 'demo' }, ctx);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('Skill execution error: boom');
    });
  });

  describe('onProgress', () => {
    it('emits starting + completing stages', async () => {
      getSkillMock.mockReturnValue(makeSkill({ name: 'demo' }));
      const onProgress = vi.fn();
      await run({ command: 'demo' }, makeCtx(), allowAll, onProgress);
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
