import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { foldToolAccess } from '../../../src/host/tools/dispatch/foldToolAccess';
import {
  getWriteIsolationScope,
  WriteIsolationManager,
  type WriteIsolationScope,
} from '../../../src/host/security/writeIsolation';
import {
  toolResourceAccessesConflict,
  type ResolvedToolAccess,
} from '../../../src/host/security/resourceScope';
import { resolveFoldedToolAccess } from '../../../src/host/security/toolAccessResolve';

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolres-scope-')));
const sub = path.join(workspace, 'sub');
fs.mkdirSync(sub);

afterAll(() => {
  fs.rmSync(workspace, { recursive: true, force: true });
});

interface ScopeRow {
  readonly toolName: string;
  readonly params: Record<string, unknown>;
  readonly level: string | null;
  readonly cwd: 'workspace' | 'sub';
  readonly expect: null | { readonly kind: 'file' | 'workspace'; readonly relativeTarget: string };
}

const SCOPE_ROWS: readonly ScopeRow[] = [
  { toolName: 'Bash', params: {}, level: 'execute', cwd: 'workspace', expect: { kind: 'workspace', relativeTarget: '' } },
  { toolName: 'bash', params: { command: 'ls' }, level: 'read', cwd: 'workspace', expect: { kind: 'workspace', relativeTarget: '' } },
  { toolName: 'shell', params: {}, level: null, cwd: 'workspace', expect: { kind: 'workspace', relativeTarget: '' } },
  { toolName: 'Write', params: { path: 'a.txt' }, level: 'write', cwd: 'workspace', expect: { kind: 'file', relativeTarget: 'a.txt' } },
  { toolName: 'Write', params: { file_path: 'dir/b.txt' }, level: 'write', cwd: 'workspace', expect: { kind: 'file', relativeTarget: path.join('dir', 'b.txt') } },
  { toolName: 'Edit', params: { target_path: 'dir/b.txt' }, level: 'write', cwd: 'workspace', expect: { kind: 'file', relativeTarget: path.join('dir', 'b.txt') } },
  { toolName: 'Write', params: {}, level: 'write', cwd: 'workspace', expect: { kind: 'workspace', relativeTarget: '' } },
  { toolName: 'Write', params: { output_path: path.join('out', 'c.txt') }, level: 'write', cwd: 'sub', expect: { kind: 'file', relativeTarget: path.join('sub', 'out', 'c.txt') } },
  { toolName: 'Write', params: { path: '../outside.txt' }, level: 'write', cwd: 'sub', expect: { kind: 'file', relativeTarget: 'outside.txt' } },
  { toolName: 'Write', params: { path: 'ABS' }, level: 'write', cwd: 'workspace', expect: { kind: 'file', relativeTarget: 'abs.txt' } },
  { toolName: 'Task', params: { prompt: 'x' }, level: 'execute', cwd: 'workspace', expect: null },
  { toolName: 'spawn_agent', params: {}, level: 'execute', cwd: 'workspace', expect: null },
  { toolName: 'workflow', params: { workflow: 'custom' }, level: 'execute', cwd: 'workspace', expect: null },
  { toolName: 'Read', params: { path: 'a.txt' }, level: 'read', cwd: 'workspace', expect: null },
  { toolName: 'custom_tool', params: { path: 'a.txt' }, level: 'write', cwd: 'workspace', expect: { kind: 'file', relativeTarget: 'a.txt' } },
  { toolName: 'custom_tool', params: { path: 'a.txt' }, level: 'read', cwd: 'workspace', expect: null },
  { toolName: 'execute_command', params: { command: 'pwd' }, level: null, cwd: 'workspace', expect: { kind: 'workspace', relativeTarget: '' } },
];

function scopeFor(
  toolName: string,
  params: Record<string, unknown>,
  level: string,
  root = workspace,
  cwd = root,
): WriteIsolationScope {
  const scope = getWriteIsolationScope(toolName, params, root, level, cwd);
  expect(scope).not.toBeNull();
  if (!scope) throw new Error(`missing scope for ${toolName}`);
  return scope;
}

function asWrite(scope: WriteIsolationScope): ResolvedToolAccess {
  if (scope.kind === 'workspace') {
    return {
      kind: 'write',
      domain: { type: 'workspace', root: scope.root, targetPath: scope.targetPath },
    };
  }
  return {
    kind: 'write',
    domain: { type: 'path', root: scope.root, targetPath: scope.targetPath },
  };
}

async function managerConflicts(left: WriteIsolationScope, right: WriteIsolationScope): Promise<boolean> {
  const manager = new WriteIsolationManager();
  const release = await manager.acquire(left);
  let acquired = false;
  const pending = manager.acquire(right).then((releaseRight) => {
    acquired = true;
    releaseRight();
  });
  await Promise.resolve();
  const conflicts = !acquired;
  release();
  await pending;
  manager.reset();
  return conflicts;
}

describe('getWriteIsolationScope after the shared path extract', () => {
  it('keeps the pre-extract scope table for 17 tool, param, and level rows', () => {
    expect(SCOPE_ROWS.length).toBeGreaterThanOrEqual(12);
    for (const row of SCOPE_ROWS) {
      const params = { ...row.params };
      if (params.path === 'ABS') params.path = path.join(workspace, 'abs.txt');
      const cwd = row.cwd === 'sub' ? sub : workspace;
      const scope = getWriteIsolationScope(row.toolName, params, workspace, row.level ?? undefined, cwd);
      if (row.expect === null) {
        expect(scope, row.toolName).toBeNull();
        continue;
      }
      expect(scope, row.toolName).not.toBeNull();
      if (!scope) continue;
      expect(scope.kind, row.toolName).toBe(row.expect.kind);
      expect(scope.toolName).toBe(row.toolName);
      expect(scope.root).toBe(workspace);
      expect(path.relative(scope.root, scope.targetPath), row.toolName).toBe(row.expect.relativeTarget);
      const prefix = scope.kind === 'workspace' ? 'workspace' : 'file';
      expect(scope.lockKey).toBe(`${prefix}:${scope.targetPath}`);
    }
  });
});

describe('shared resource conflict', () => {
  it('answers path and workspace conflicts the same way through write isolation and the resolver', async () => {
    const otherWorkspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'toolres-other-')));
    try {
      const sameFile = scopeFor('Write', { path: 'a.txt' }, 'write');
      const parent = scopeFor('Write', { path: 'dir' }, 'write');
      const child = scopeFor('Write', { path: path.join('dir', 'child.txt') }, 'write');
      const sibling = scopeFor('Write', { path: 'b.txt' }, 'write');
      const wholeTree = scopeFor('Bash', {}, 'execute');
      const otherFile = scopeFor('Write', { path: 'a.txt' }, 'write', otherWorkspace);
      const pairs = [
        [sameFile, scopeFor('Write', { path: 'a.txt' }, 'write')],
        [parent, child],
        [sameFile, sibling],
        [wholeTree, sameFile],
        [sameFile, otherFile],
      ];
      expect(pairs.length).toBeGreaterThanOrEqual(5);
      for (const [left, right] of pairs) {
        const throughManager = await managerConflicts(left, right);
        const throughResolver = toolResourceAccessesConflict(asWrite(left), asWrite(right));
        expect(throughManager).toBe(throughResolver);
      }
      expect(await managerConflicts(parent, child)).toBe(true);
      expect(await managerConflicts(sameFile, sibling)).toBe(false);
      expect(await managerConflicts(wholeTree, sameFile)).toBe(true);
      expect(await managerConflicts(sameFile, otherFile)).toBe(false);

      const folded = foldToolAccess({
        accesses: [{ kind: 'write', argumentNames: ['path'] }],
      });
      const resolved = resolveFoldedToolAccess({
        toolName: 'Write',
        folded,
        params: { path: path.join('dir', 'child.txt') },
        workspace,
        cwd: workspace,
      });
      expect(resolved).toEqual([asWrite(child)]);
    } finally {
      fs.rmSync(otherWorkspace, { recursive: true, force: true });
    }
  });

  it('lets two reads share a path, and treats an unknown domain as a conflict', () => {
    const file = scopeFor('Write', { path: 'a.txt' }, 'write');
    const pathDomain = { type: 'path' as const, root: file.root, targetPath: file.targetPath };
    expect(toolResourceAccessesConflict(
      { kind: 'read', domain: pathDomain },
      { kind: 'read', domain: pathDomain },
    )).toBe(false);
    expect(toolResourceAccessesConflict(
      { kind: 'read', domain: pathDomain },
      { kind: 'write', domain: pathDomain },
    )).toBe(true);
    const unknownRead: ResolvedToolAccess = { kind: 'read', domain: { type: 'unknown' } };
    expect(toolResourceAccessesConflict(unknownRead, { kind: 'write', domain: pathDomain })).toBe(true);
    expect(toolResourceAccessesConflict(unknownRead, { kind: 'read', domain: pathDomain })).toBe(true);
    expect(toolResourceAccessesConflict(
      unknownRead,
      { kind: 'readwrite', domain: { type: 'unknown' } },
    )).toBe(true);

    const named = (name: string, kind: ResolvedToolAccess['kind']): ResolvedToolAccess => ({
      kind,
      domain: { type: 'named', name },
    });
    expect(toolResourceAccessesConflict(named('session:plan', 'read'), named('session:plan', 'read'))).toBe(false);
    expect(toolResourceAccessesConflict(named('session:plan', 'write'), named('session:plan', 'write'))).toBe(true);
    expect(toolResourceAccessesConflict(named('session:plan', 'write'), named('pty:current', 'write'))).toBe(false);

    const unscopedRead: ResolvedToolAccess = { kind: 'read', domain: { type: 'unscoped' } };
    expect(toolResourceAccessesConflict(unscopedRead, { kind: 'write', domain: pathDomain })).toBe(false);
    expect(toolResourceAccessesConflict(unscopedRead, unscopedRead)).toBe(false);
  });

  it('resolves fixed names, optional files, and missing path arguments', () => {
    const fixed = resolveFoldedToolAccess({
      toolName: 'enter_plan_mode',
      folded: foldToolAccess({ accesses: [{ kind: 'write' }] }),
      params: {},
      workspace,
      cwd: workspace,
    });
    expect(fixed).toEqual([{ kind: 'write', domain: { type: 'named', name: 'fixed:enter_plan_mode' } }]);

    const skipped = resolveFoldedToolAccess({
      toolName: 'WebSearch',
      folded: foldToolAccess({
        accesses: [{ kind: 'write', expression: 'workspaceFile(args.save_to)' }],
      }),
      params: {},
      workspace,
      cwd: workspace,
    });
    expect(skipped).toEqual([{ kind: 'readwrite', domain: { type: 'unknown' } }]);

    const saved = resolveFoldedToolAccess({
      toolName: 'WebSearch',
      folded: foldToolAccess({
        accesses: [
          { kind: 'read', expression: 'resource(network, web_search)' },
          { kind: 'write', expression: 'workspaceFile(args.save_to)' },
        ],
      }),
      params: { save_to: 'out/search.md' },
      workspace,
      cwd: workspace,
    });
    const savedFile = scopeFor('Write', { path: path.join('out', 'search.md') }, 'write');
    expect(saved).toEqual([
      { kind: 'read', domain: { type: 'named', name: 'network:web_search' } },
      { kind: 'write', domain: { type: 'path', root: savedFile.root, targetPath: savedFile.targetPath } },
    ]);

    const missingPath = resolveFoldedToolAccess({
      toolName: 'ppt_generate',
      folded: foldToolAccess({
        accesses: [{ kind: 'write', argumentNames: ['output_path'] }],
      }),
      params: {},
      workspace,
      cwd: workspace,
    });
    expect(missingPath).toEqual([{ kind: 'write', domain: { type: 'unknown' } }]);

    const several = resolveFoldedToolAccess({
      toolName: 'declare_deliverables',
      folded: foldToolAccess({
        accesses: [{ kind: 'write', argumentNames: ['final_artifacts'] }],
      }),
      params: { final_artifacts: ['a.txt', 'dir/b.txt'] },
      workspace,
      cwd: workspace,
    });
    const firstArtifact = scopeFor('Write', { path: 'a.txt' }, 'write');
    const secondArtifact = scopeFor('Write', { path: path.join('dir', 'b.txt') }, 'write');
    expect(several).toEqual([
      { kind: 'write', domain: { type: 'path', root: firstArtifact.root, targetPath: firstArtifact.targetPath } },
      { kind: 'write', domain: { type: 'path', root: secondArtifact.root, targetPath: secondArtifact.targetPath } },
    ]);

    const workspaceLock = resolveFoldedToolAccess({
      toolName: 'Bash',
      folded: foldToolAccess({
        accesses: [{ kind: 'write', expression: 'workspace()' }],
      }),
      params: {},
      workspace,
      cwd: sub,
    });
    const bash = scopeFor('Bash', {}, 'execute');
    expect(workspaceLock).toEqual([asWrite(bash)]);
  });
});
