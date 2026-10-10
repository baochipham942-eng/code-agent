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
  normalizeTargetPath,
  toolResourceAccessesConflict,
  type ResolvedToolAccess,
} from '../../../src/host/security/resourceScope';
import { resolveFoldedToolAccess } from '../../../src/host/security/toolAccessResolve';
import {
  createConflictFixtureWorkspace,
  destroyConflictFixtureWorkspace,
  toolResourceConflictCases,
  type ToolResourceConflictCase,
} from '../../fixtures/toolResourceConflictCases';

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

  it('resolves a missing or blank read path to an unscoped read (no guessing the tool default) and keeps write paths unknown', () => {
    const root = normalizeTargetPath(workspace, '.');
    const readOf = (params: Record<string, unknown>, argumentNames: readonly string[] = ['path']) => resolveFoldedToolAccess({
      toolName: 'Grep',
      folded: foldToolAccess({ accesses: [{ kind: 'read', argumentNames }] }),
      params,
      workspace,
      cwd: sub,
    });
    const unscopedRead = [{ kind: 'read' as const, domain: { type: 'unscoped' as const } }];
    expect(readOf({})).toEqual(unscopedRead);
    expect(readOf({ path: '   ' })).toEqual(unscopedRead);
    expect(readOf({ path: [] })).toEqual(unscopedRead);

    const concrete = normalizeTargetPath(sub, 'a.txt');
    expect(readOf({ path: 'a.txt' })).toEqual([
      { kind: 'read', domain: { type: 'path', root, targetPath: concrete } },
    ]);
    expect(readOf({ path: '  ', paths: ['a.txt'] }, ['path', 'paths'])).toEqual([
      { kind: 'read', domain: { type: 'path', root, targetPath: concrete } },
    ]);
    expect(readOf({ paths: ['a.txt', '  '] }, ['paths'])).toEqual([{ kind: 'read', domain: { type: 'unknown' } }]);
    expect(readOf({ path: 3 })).toEqual([{ kind: 'read', domain: { type: 'unknown' } }]);

    const blankWrite = resolveFoldedToolAccess({
      toolName: 'ppt_generate',
      folded: foldToolAccess({ accesses: [{ kind: 'write', argumentNames: ['output_path'] }] }),
      params: { output_path: '   ' },
      workspace,
      cwd: workspace,
    });
    expect(blankWrite).toEqual([{ kind: 'write', domain: { type: 'unknown' } }]);
    const emptyWrite = resolveFoldedToolAccess({
      toolName: 'ppt_generate',
      folded: foldToolAccess({ accesses: [{ kind: 'write', argumentNames: ['output_path'] }] }),
      params: { output_path: [] },
      workspace,
      cwd: workspace,
    });
    expect(emptyWrite).toEqual([{ kind: 'write', domain: { type: 'unknown' } }]);
  });

  it('conflicts agent:runtime with path access and leaves write-isolation answers unchanged', async () => {
    expect(getWriteIsolationScope('Task', { prompt: 'x' }, workspace, 'execute', workspace)).toBeNull();
    expect(getWriteIsolationScope('spawn_agent', {}, workspace, 'execute', workspace)).toBeNull();
    expect(getWriteIsolationScope('Explore', { prompt: 'x' }, workspace, 'execute', workspace)).not.toBeNull();

    const file = scopeFor('Write', { path: 'a.txt' }, 'write');
    const tree = scopeFor('Bash', {}, 'execute');
    expect(await managerConflicts(file, tree)).toBe(true);
    expect(toolResourceAccessesConflict(asWrite(file), asWrite(tree))).toBe(true);
    expect(await managerConflicts(file, scopeFor('Write', { path: 'b.txt' }, 'write'))).toBe(false);

    const agent = (kind: ResolvedToolAccess['kind']): ResolvedToolAccess => ({
      kind,
      domain: { type: 'named', name: 'agent:runtime' },
    });
    const pathRead: ResolvedToolAccess = { kind: 'read', domain: { type: 'path', root: file.root, targetPath: file.targetPath } };
    const unscoped: ResolvedToolAccess = { kind: 'read', domain: { type: 'unscoped' } };
    const otherNamed: ResolvedToolAccess = { kind: 'read', domain: { type: 'named', name: 'session:plan' } };
    expect(toolResourceAccessesConflict(agent('write'), agent('write'))).toBe(false);
    expect(toolResourceAccessesConflict(agent('read'), agent('read'))).toBe(false);
    expect(toolResourceAccessesConflict(agent('write'), pathRead)).toBe(true);
    expect(toolResourceAccessesConflict(agent('read'), pathRead)).toBe(true);
    expect(toolResourceAccessesConflict(pathRead, agent('read'))).toBe(true);
    expect(toolResourceAccessesConflict(agent('read'), asWrite(tree))).toBe(true);
    expect(toolResourceAccessesConflict(agent('read'), otherNamed)).toBe(true);
    expect(toolResourceAccessesConflict(agent('write'), otherNamed)).toBe(true);
    expect(toolResourceAccessesConflict(agent('write'), unscoped)).toBe(false);
    expect(toolResourceAccessesConflict(agent('read'), unscoped)).toBe(false);
    expect(toolResourceAccessesConflict(agent('read'), { kind: 'read', domain: { type: 'unknown' } })).toBe(true);
    expect(toolResourceAccessesConflict(
      { kind: 'write', domain: { type: 'named', name: 'session:plan' } },
      { kind: 'write', domain: { type: 'named', name: 'pty:current' } },
    )).toBe(false);
  });
});

describe('scheduler path normalization matches the file tools (rework r2)', () => {
  it('expands ~ the way Read/Write resolveInputPath do, so both spellings share one domain', () => {
    const home = os.homedir();
    expect(normalizeTargetPath(sub, '~/notes.md')).toBe(normalizeTargetPath(sub, path.join(home, 'notes.md')));
    expect(normalizeTargetPath(sub, '~')).toBe(normalizeTargetPath(sub, home));
    // 非 ~ 前缀的路径保持原语义：仍是相对 cwd 的字面路径
    expect(normalizeTargetPath(sub, 'a~b.md')).toBe(normalizeTargetPath(sub, 'a~b.md'));
  });

  it('gives the ~ spelling and the absolute spelling the same write lock key', () => {
    const tilde = scopeFor('Write', { file_path: '~/notes.md' }, 'write');
    const absolute = scopeFor('Write', { file_path: path.join(os.homedir(), 'notes.md') }, 'write');
    expect(tilde.kind).toBe('file');
    expect(tilde.lockKey).toBe(absolute.lockKey);
  });

  it('strips Read embedded params before resolving the path domain', () => {
    const readOf = (file_path: string) => resolveFoldedToolAccess({
      toolName: 'Read',
      folded: foldToolAccess({ accesses: [{ kind: 'read', argumentNames: ['file_path'] }] }),
      params: { file_path },
      workspace,
      cwd: workspace,
    });
    const plain = readOf('a.md');
    for (const embedded of ['a.md lines 1-20', 'a.md line 7', 'a.md offset=10', 'a.md offset 10 limit 5']) {
      expect(readOf(embedded), embedded).toEqual(plain);
    }
  });
});

describe('glob-pattern read scoping and unprovable write targets (rework r3)', () => {
  const globScope = (params: Record<string, unknown>, argumentNames: readonly string[] = ['path', 'pattern']) => resolveFoldedToolAccess({
    toolName: 'Glob',
    folded: foldToolAccess({ accesses: [{ kind: 'read', argumentNames }] }),
    params,
    workspace,
    cwd: workspace,
  });

  it('scopes a wildcard pattern to its static directory prefix joined onto the base path argument', () => {
    const readAt = (target: string) => ({
      kind: 'read',
      domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: normalizeTargetPath(workspace, target) },
    });
    expect(globScope({ pattern: 'src/**/*.ts' })).toEqual([readAt('src')]);
    // 基目录自身也在作用域里（对冲突判定只增不减），模式前缀并入基目录。
    expect(globScope({ path: 'docs', pattern: 'src/**/*.ts' })).toEqual([readAt('docs'), readAt(path.join('docs', 'src'))]);
    expect(globScope({ pattern: '*.md' })).toEqual([readAt('.')]);
  });

  it.each(['/tmp/out/*.md', '../out/*.md', 'src/../../out/*.md', '~/docs/*.md'])(
    'sends absolute or ..-escaping patterns (%s) to the unknown domain',
    (pattern) => {
      expect(globScope({ pattern })).toEqual([{ kind: 'read', domain: { type: 'unknown' } }]);
    },
  );

  it('joins a literal (non-glob) pattern onto the base too: exact.ts under docs is docs/exact.ts', () => {
    const literal = globScope({ path: 'docs', pattern: 'exact.ts' });
    const docsDir = normalizeTargetPath(workspace, 'docs');
    const exactFile = normalizeTargetPath(workspace, path.join('docs', 'exact.ts'));
    expect(literal).toEqual([
      { kind: 'read', domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: docsDir } },
      { kind: 'read', domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: exactFile } },
    ]);
    // 独立路径不挤进一个声明：数组元素彼此并列（input_files 形状），不互相拼接。
    const siblings = resolveFoldedToolAccess({
      toolName: 'PdfAutomate',
      folded: foldToolAccess({ accesses: [{ kind: 'read', argumentNames: ['input_files'] }] }),
      params: { input_files: ['a.pdf', 'dir/b.pdf'] },
      workspace,
      cwd: workspace,
    });
    expect(siblings).toEqual([
      { kind: 'read', domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: normalizeTargetPath(workspace, 'a.pdf') } },
      { kind: 'read', domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: normalizeTargetPath(workspace, path.join('dir', 'b.pdf')) } },
    ]);
  });

  it('treats a missing write-side argument as unprovable, not as absent', () => {
    const excelFold = foldToolAccess({
      accesses: [
        { kind: 'readwrite', argumentNames: ['file_path'] },
        { kind: 'write', argumentNames: ['output_path'] },
      ],
    });
    const editOnly = resolveFoldedToolAccess({
      toolName: 'ExcelAutomate',
      folded: excelFold,
      params: { file_path: 'a.xlsx' },
      workspace,
      cwd: workspace,
    });
    // output_path 缺席：generate 默认写到哪里不可证 → 未知域串行
    expect(editOnly).toContainEqual({ kind: 'write', domain: { type: 'unknown' } });
    const both = resolveFoldedToolAccess({
      toolName: 'ExcelAutomate',
      folded: excelFold,
      params: { file_path: 'a.xlsx', output_path: 'b.xlsx' },
      workspace,
      cwd: workspace,
    });
    expect(both.length).toBe(2);
    expect(both.every((access) => access.domain.type === 'path')).toBe(true);
  });

  it('keeps read-kind tolerance for missing values (Grep path/include stays cwd-scoped)', () => {
    const readOf = resolveFoldedToolAccess({
      toolName: 'Grep',
      folded: foldToolAccess({ accesses: [{ kind: 'read', argumentNames: ['path', 'include'] }] }),
      params: { include: '*.js' },
      workspace,
      cwd: workspace,
    });
    expect(readOf).toEqual([{
      kind: 'read',
      domain: { type: 'path', root: normalizeTargetPath(workspace, '.'), targetPath: normalizeTargetPath(workspace, '.') },
    }]);
  });
});

// ADR-073 K3 Test B：同一张共享冲突表驱动运行时写锁——两侧都有锁的行
// manager 等待当且仅当表行声明冲突；无锁行断言对应侧 scope 为 null。
// 静态侧（Test A）在 tests/unit/agent/parallelStrategy.test.ts。
describe('shared conflict table drives the runtime write lock', () => {
  const k3ws = createConflictFixtureWorkspace();

  afterAll(() => {
    destroyConflictFixtureWorkspace(k3ws);
  });

  it('waits on a pair iff the shared table says conflict, for pairs that both lock', async () => {
    for (const row of toolResourceConflictCases(k3ws)) {
      const scopeOf = (side: ToolResourceConflictCase['left']) => getWriteIsolationScope(
        side.toolName,
        side.params,
        k3ws.root,
        side.permissionLevel ?? undefined,
        k3ws.root,
      );
      const left = scopeOf(row.left);
      const right = scopeOf(row.right);
      if (row.runtimeLock) {
        expect(left, row.note).not.toBeNull();
        expect(right, row.note).not.toBeNull();
        if (!left || !right) continue;
        expect(await managerConflicts(left, right), row.note).toBe(row.conflict);
        continue;
      }
      // 无锁行：至少一侧运行时根本没有锁（两读 / Task / Read 侧），不存在等待可断言。
      expect(left === null || right === null, row.note).toBe(true);
    }
  });
});
