// ============================================================================
// SkillCreate (native ToolModule) Tests — P0-6.x Wave 1
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';
import type { ParsedSkill } from '../../../../../src/shared/contract/agentSkill';

// -----------------------------------------------------------------------------
// Mock skill registry + config
// -----------------------------------------------------------------------------

const ensureInitializedMock = vi.fn(async (_dir: string) => {});
const getSkillMock = vi.fn<(name: string) => ParsedSkill | undefined>();
let registryAvailable = true;

vi.mock('../../../../../src/host/services/skills', () => ({
  getSkillDiscoveryService: () =>
    registryAvailable
      ? {
          ensureInitialized: ensureInitializedMock,
          getSkill: getSkillMock,
        }
      : undefined,
}));

let tmpRoot = '';
const getSkillsDirMock = vi.fn<() => { user: { new: string }; project?: { new: string } }>();
vi.mock('../../../../../src/host/config/configPaths', () => ({
  getSkillsDir: () => getSkillsDirMock(),
}));

import { skillCreateModule } from '../../../../../src/host/tools/modules/skill/skillCreate';

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
    workingDir: tmpRoot,
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
  const handler = await skillCreateModule.createHandler();
  return handler.execute(args, ctx, canUseTool, onProgress as never);
}

beforeEach(async () => {
  registryAvailable = true;
  ensureInitializedMock.mockReset();
  ensureInitializedMock.mockImplementation(async () => {});
  getSkillMock.mockReset();
  getSkillMock.mockReturnValue(undefined);

  // 真实临时目录，避免 mock fs 的复杂度
  tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-create-test-'));
  getSkillsDirMock.mockReset();
  getSkillsDirMock.mockReturnValue({
    user: { new: path.join(tmpRoot, 'user-skills') },
    project: { new: path.join(tmpRoot, 'project-skills') },
  });
});

// -----------------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------------

describe('skillCreateModule (native)', () => {
  describe('schema', () => {
    it('has correct metadata', () => {
      expect(skillCreateModule.schema.name).toBe('SkillCreate');
      expect(skillCreateModule.schema.category).toBe('skill');
      expect(skillCreateModule.schema.permissionLevel).toBe('write');
      expect(skillCreateModule.schema.readOnly).toBe(false);
      expect(skillCreateModule.schema.allowInPlanMode).toBe(false);
      expect(skillCreateModule.schema.inputSchema.required).toEqual([
        'name',
        'description',
        'content',
      ]);
      expect(skillCreateModule.schema.inputSchema.properties).toHaveProperty('name');
      expect(skillCreateModule.schema.inputSchema.properties).toHaveProperty('description');
      expect(skillCreateModule.schema.inputSchema.properties).toHaveProperty('content');
      expect(skillCreateModule.schema.inputSchema.properties).toHaveProperty('scope');
      expect(skillCreateModule.schema.inputSchema.properties).toHaveProperty('allowedTools');
    });
  });

  describe('validation & errors', () => {
    it('rejects missing name', async () => {
      const result = await run({ description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing description', async () => {
      const result = await run({ name: 'foo', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects missing content', async () => {
      const result = await run({ name: 'foo', description: 'd' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects invalid name (uppercase)', async () => {
      const result = await run({ name: 'BadName', description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('INVALID_ARGS');
        expect(result.error).toContain('名称无效');
      }
    });

    it('rejects empty name', async () => {
      const result = await run({ name: '', description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });

    it('rejects too long name (>64)', async () => {
      const long = 'a'.repeat(65);
      const result = await run({ name: long, description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('名称无效');
    });

    it('rejects too long description (>1024)', async () => {
      const result = await run({
        name: 'foo',
        description: 'x'.repeat(1025),
        content: 'c',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('描述超长');
    });

    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const result = await run(
        { name: 'foo', description: 'd', content: 'c' },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when signal pre-aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const ctx = makeCtx({ abortSignal: ctrl.signal });
      const result = await run(
        { name: 'foo', description: 'd', content: 'c' },
        ctx,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });

    it('returns NOT_INITIALIZED when registry unavailable', async () => {
      registryAvailable = false;
      const result = await run({ name: 'foo', description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('NOT_INITIALIZED');
    });

    it('returns SKILL_EXISTS when name already taken', async () => {
      getSkillMock.mockReturnValue({
        name: 'foo',
        description: 'existing',
        promptContent: '',
        basePath: '/old/path',
        allowedTools: [],
        disableModelInvocation: false,
        userInvocable: true,
        executionContext: 'inline',
        source: 'user',
      });
      const result = await run({ name: 'foo', description: 'd', content: 'c' });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('SKILL_EXISTS');
        expect(result.error).toContain('Skill "foo" 已存在');
        expect(result.error).toContain('/old/path');
      }
    });

    it('continues despite ensureInitialized throwing (legacy parity)', async () => {
      ensureInitializedMock.mockRejectedValue(new Error('init boom'));
      const result = await run({ name: 'foo', description: 'd', content: 'c' });
      // 写入应当依然成功（与 legacy 行为一致）
      expect(result.ok).toBe(true);
    });
  });

  describe('happy path', () => {
    it('creates user-scope skill by default', async () => {
      const result = await run({
        name: 'foo-bar',
        description: 'My demo skill',
        content: '# Hello\nbody',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillPath = path.join(tmpRoot, 'user-skills', 'foo-bar', 'SKILL.md');
        const written = await fs.readFile(skillPath, 'utf-8');
        expect(written).toContain('name: foo-bar');
        expect(written).toContain('description: "My demo skill"');
        expect(written).toContain('user-invocable: true');
        expect(written).toContain('context: inline');
        expect(written).toContain('# Hello');
        expect(written).toContain('body');
        expect(result.output).toContain('Skill "foo-bar" 已创建');
        expect(result.output).toContain(skillPath);
        expect(result.output).toContain('范围: user');
      }
    });

    it('creates project-scope skill when scope=project', async () => {
      const result = await run({
        name: 'proj-skill',
        description: 'project',
        content: 'body',
        scope: 'project',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillPath = path.join(tmpRoot, 'project-skills', 'proj-skill', 'SKILL.md');
        await expect(fs.stat(skillPath)).resolves.toBeDefined();
        expect(result.output).toContain('范围: project');
      }
    });

    it('falls back to user when scope=project but project dir undefined', async () => {
      getSkillsDirMock.mockReturnValueOnce({
        user: { new: path.join(tmpRoot, 'user-skills') },
        project: undefined,
      });
      const result = await run({
        name: 'falls-back',
        description: 'd',
        content: 'c',
        scope: 'project',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillPath = path.join(tmpRoot, 'user-skills', 'falls-back', 'SKILL.md');
        await expect(fs.stat(skillPath)).resolves.toBeDefined();
      }
    });

    it('emits allowed-tools when provided', async () => {
      const result = await run({
        name: 'with-tools',
        description: 'd',
        content: 'c',
        allowedTools: 'Read Write',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillPath = path.join(tmpRoot, 'user-skills', 'with-tools', 'SKILL.md');
        const written = await fs.readFile(skillPath, 'utf-8');
        expect(written).toContain('allowed-tools: "Read Write"');
      }
    });

    it('escapes double quotes in description', async () => {
      const result = await run({
        name: 'q-skill',
        description: 'has "quotes"',
        content: 'c',
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        const skillPath = path.join(tmpRoot, 'user-skills', 'q-skill', 'SKILL.md');
        const written = await fs.readFile(skillPath, 'utf-8');
        expect(written).toContain('description: "has \\"quotes\\""');
      }
    });

    it('returns FS_ERROR when write fails', async () => {
      // 让 user-skills 指向一个非法路径（在已存在的文件下建子目录）
      const blockingFile = path.join(tmpRoot, 'block.txt');
      await fs.writeFile(blockingFile, 'x');
      getSkillsDirMock.mockReturnValue({
        user: { new: path.join(blockingFile, 'cant-mkdir') },
      });
      const result = await run({
        name: 'will-fail',
        description: 'd',
        content: 'c',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('FS_ERROR');
        expect(result.error).toContain('写入失败');
      }
    });
  });

  describe('onProgress', () => {
    it('emits starting + completing stages', async () => {
      const onProgress = vi.fn();
      await run(
        { name: 'p-skill', description: 'd', content: 'c' },
        makeCtx(),
        allowAll,
        onProgress,
      );
      const stages = onProgress.mock.calls.map((c) => c[0].stage);
      expect(stages).toContain('starting');
      expect(stages).toContain('completing');
    });
  });
});
