import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';
import { FENCED_IN_PROJECT_WRITE_REASON } from '../../../src/host/sandbox/writeFence';
import { fileReadTracker } from '../../../src/host/tools/fileReadTracker';
import { editModule } from '../../../src/host/tools/modules/file/multiEdit';
import { writeModule } from '../../../src/host/tools/modules/file/write';

const SANDBOX_DENYLIST_WRITE_REASON = 'write target is on the sandbox deny list';
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import * as sensitivePaths from '../../../src/host/sandbox/sensitivePaths';

vi.mock('../../../src/host/tools/lsp/diagnosticsHelper', () => ({
  getPostEditDiagnostics: async () => null,
}));

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(projectRoot: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'sandbox-tool-layer-test',
    agentId: 'sandbox-tool-layer-agent',
    workingDir: projectRoot,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    requiresOsWriteFence: true,
    writeFenceWorkspaceRoot: projectRoot,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('Write/Edit sandbox write fence', () => {
  let root: string;
  let project: string;
  let sibling: string;

  beforeEach(async () => {
    vi.stubEnv('OS_SANDBOX_ENABLED', 'true');
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-tool-write-fence-'));
    project = path.join(root, 'project');
    sibling = path.join(root, 'sibling');
    await fs.mkdir(project, { recursive: true });
    await fs.mkdir(sibling, { recursive: true });
    fileReadTracker.clear();
  });

  afterEach(async () => {
    fileReadTracker.clear();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('still denies outside the fence root when the skip-confirm obligation is set', async () => {
    const handler = await writeModule.createHandler();
    const inside = path.join(project, 'inside.txt');
    const outside = path.join(sibling, 'outside.txt');

    const insideResult = await handler.execute({ file_path: inside, content: 'inside' }, makeCtx(project), allowAll);
    expect(insideResult.ok).toBe(true);
    expect(await fs.readFile(inside, 'utf-8')).toBe('inside');

    const outsideResult = await handler.execute({ file_path: outside, content: 'outside' }, makeCtx(project), allowAll);
    expect(outsideResult.ok).toBe(false);
    if (!outsideResult.ok) expect(outsideResult.error).toContain(FENCED_IN_PROJECT_WRITE_REASON);
    await expect(fs.access(outside)).rejects.toThrow();
  });

  it('allows Edit inside the sandbox root and denies a sibling', async () => {
    const handler = await editModule.createHandler();
    const inside = path.join(project, 'inside.txt');
    const outside = path.join(sibling, 'outside.txt');
    await fs.writeFile(inside, 'before', 'utf-8');
    await fs.writeFile(outside, 'before', 'utf-8');

    const insideResult = await handler.execute(
      { file_path: inside, edits: [{ old_text: 'before', new_text: 'after' }], force: true, force_reason: 'test' },
      makeCtx(project),
      allowAll,
    );
    expect(insideResult.ok).toBe(true);
    expect(await fs.readFile(inside, 'utf-8')).toBe('after');

    const outsideResult = await handler.execute(
      { file_path: outside, edits: [{ old_text: 'before', new_text: 'after' }], force: true, force_reason: 'test' },
      makeCtx(project),
      allowAll,
    );
    expect(outsideResult.ok).toBe(false);
    if (!outsideResult.ok) expect(outsideResult.error).toContain(FENCED_IN_PROJECT_WRITE_REASON);
    expect(await fs.readFile(outside, 'utf-8')).toBe('before');
  });

  it('keeps the existing behavior when the OS sandbox is disabled', async () => {
    vi.stubEnv('OS_SANDBOX_ENABLED', 'false');
    const handler = await writeModule.createHandler();
    const outside = path.join(sibling, 'outside-disabled.txt');

    const result = await handler.execute({ file_path: outside, content: 'allowed' }, makeCtx(project), allowAll);
    expect(result.ok).toBe(true);
    expect(await fs.readFile(outside, 'utf-8')).toBe('allowed');
    const edit = await editModule.createHandler();
    const edited = await edit.execute(
      { file_path: outside, edits: [{ old_text: 'allowed', new_text: 'edited' }], force: true, force_reason: 'test' },
      makeCtx(project), allowAll,
    );
    expect(edited.ok).toBe(true);
    expect(await fs.readFile(outside, 'utf-8')).toBe('edited');
  });

  it('denies writes under a denied-read root even when it is inside the write root', async () => {
    const denied = path.join(project, 'denied');
    await fs.mkdir(denied, { recursive: true });
    const target = path.join(denied, 'secret.txt');
    const handler = await writeModule.createHandler();

    const result = await handler.execute(
      { file_path: target, content: 'blocked' },
      makeCtx(project, { deniedReadRoots: [denied] }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(SANDBOX_DENYLIST_WRITE_REASON);
    await expect(fs.access(target)).rejects.toThrow();
    await fs.writeFile(target, 'original');
    const edit = await editModule.createHandler();
    const edited = await edit.execute(
      { file_path: target, edits: [{ old_text: 'original', new_text: 'changed' }], force: true, force_reason: 'test' },
      makeCtx(project, { deniedReadRoots: [denied] }), allowAll,
    );
    expect(edited).toMatchObject({ ok: false, code: 'SANDBOX_WRITE_DENIED', error: SANDBOX_DENYLIST_WRITE_REASON });
    expect(await fs.readFile(target, 'utf-8')).toBe('original');
  });

  describe.each(['Write', 'Edit'] as const)('%s root resolution', (tool) => {
    async function execute(target: string, ctx: ToolContext) {
      const handler = await (tool === 'Write' ? writeModule : editModule).createHandler();
      if (tool === 'Edit') await fs.writeFile(target, 'before');
      return handler.execute(tool === 'Write'
        ? { file_path: target, content: 'after' }
        : { file_path: target, edits: [{ old_text: 'before', new_text: 'after' }], force: true, force_reason: 'test' },
      ctx, allowAll);
    }

    async function expectDenied(
      target: string,
      ctx: ToolContext,
      reason = FENCED_IN_PROJECT_WRITE_REASON,
    ) {
      expect(await execute(target, ctx)).toMatchObject({
        ok: false, code: 'SANDBOX_WRITE_DENIED', error: reason,
      });
      if (tool === 'Edit') expect(await fs.readFile(target, 'utf-8')).toBe('before');
      else await expect(fs.access(target)).rejects.toThrow();
    }

    it('allows an approved write outside the workspace when no fence obligation is set', async () => {
      const ctx = makeCtx(project, { requiresOsWriteFence: undefined, writeFenceWorkspaceRoot: undefined });
      expect((await execute(path.join(project, 'cwd.txt'), ctx)).ok).toBe(true);
      const outside = path.join(sibling, `${tool.toLowerCase()}-approved.txt`);
      const result = await execute(outside, ctx);
      expect(result.ok).toBe(true);
      if (tool === 'Write') expect(await fs.readFile(outside, 'utf-8')).toBe('after');
    });

    it('does not confine an approved write to workspace roots', async () => {
      const ctx = makeCtx(project, { workingDir: root, workspace: project, requiresOsWriteFence: undefined });
      expect((await execute(path.join(project, 'workspace.txt'), ctx)).ok).toBe(true);
      expect((await execute(path.join(sibling, `${tool.toLowerCase()}-outside-workspace.txt`), ctx)).ok).toBe(true);
    });

    it('does not use workspace scope as a write fence without the obligation', async () => {
      const workspaceScope = createWorkspaceScope('sandbox-tool-project', [
        { sourceId: 'primary', path: project, role: 'primary', access: 'read_write' },
        { sourceId: 'second', path: sibling, role: 'additional', access: 'read_write' },
      ]);
      const ctx = makeCtx(project, { requiresOsWriteFence: undefined, workspaceScope });
      expect((await execute(path.join(sibling, 'second.txt'), ctx)).ok).toBe(true);
      const readOnly = createWorkspaceScope('sandbox-tool-project', [
        { sourceId: 'primary', path: project, role: 'primary', access: 'read_write' },
        { sourceId: 'docs', path: sibling, role: 'additional', access: 'read_only' },
      ]);
      expect((await execute(path.join(sibling, 'readonly.txt'), { ...ctx, workspaceScope: readOnly })).ok).toBe(true);
      expect((await execute(path.join(project, 'empty-roots.txt'), { ...ctx, workspaceScope: { ...readOnly, roots: [] } })).ok).toBe(true);
    });

    it('fails closed when the required fence root is missing', async () => {
      await expectDenied(path.join(project, 'missing-fence.txt'), makeCtx(project, { writeFenceWorkspaceRoot: undefined }));
    });

    it('rejects a symlink directory that escapes the root', async () => {
      await fs.symlink(sibling, path.join(project, 'escape'));
      const target = path.join(project, 'escape', 'symlink.txt');
      await expectDenied(target, makeCtx(project), SANDBOX_DENYLIST_WRITE_REASON);
    });

    it('rejects sensitive paths within an otherwise writable root', async () => {
      const target = path.join(project, 'credential.txt');
      vi.spyOn(sensitivePaths, 'getSensitiveSandboxPaths').mockReturnValue([{ kind: 'file', path: target }]);
      await expectDenied(target, makeCtx(project), SANDBOX_DENYLIST_WRITE_REASON);
    });
  });
});
