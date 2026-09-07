import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const gateScript = resolve('scripts/ci/snapshot-replay-sync-gate.mjs');
const roots: string[] = [];
const snapshotDir = 'packages/internal/evaluation-center/snapshots/request-replay';
const caseIndex = `${snapshotDir}/single-turn-qa/index.json`;
const sensitiveFile = 'src/host/prompts/builder.ts';

function write(root: string, relativePath: string, content: string): void {
  const absolutePath = join(root, relativePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);
}

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'snapshot-replay-sync-gate-'));
  roots.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Snapshot Sync Gate Test');
  git(root, 'config', 'user.email', 'snapshot-sync-gate@example.test');
  write(root, sensitiveFile, 'export const SYSTEM_PROMPT = "v1";\n');
  write(root, caseIndex, '{"version":1,"caseId":"single-turn-qa","turns":["turn-01"]}\n');
  write(root, 'README.md', '# fixture\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'baseline');
  return root;
}

function runGate(root: string, baseRef = 'HEAD') {
  return spawnSync(process.execPath, [
    gateScript,
    '--repo-root',
    root,
    '--base-ref',
    baseRef,
  ], { encoding: 'utf8' });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('snapshot-replay sync gate', () => {
  it('无敏感面变更时为绿', () => {
    const root = makeFixture();
    write(root, 'docs/note.md', '# docs-only\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('快照基线与模型可见行为面同步');
  });

  it('改敏感面文件不同步快照时给出人话红线', () => {
    const root = makeFixture();
    write(root, sensitiveFile, 'export const SYSTEM_PROMPT = "v2";\n');

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('改了模型可见行为面但没同 PR 重录 request-replay 快照');
    expect(result.stderr).toContain(sensitiveFile);
  });

  it('改敏感面文件且快照目录同改时为绿', () => {
    const root = makeFixture();
    write(root, sensitiveFile, 'export const SYSTEM_PROMPT = "v2";\n');
    write(root, caseIndex, '{"version":1,"caseId":"single-turn-qa","turns":["turn-01","turn-02"]}\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('删敏感面文件不同步快照时必须红（diff-filter 含 D）', () => {
    const root = makeFixture();
    unlinkSync(join(root, sensitiveFile));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('改了模型可见行为面但没同 PR 重录 request-replay 快照');
    expect(result.stderr).toContain(sensitiveFile);
  });

  it('删敏感面文件且快照目录同改时为绿', () => {
    const root = makeFixture();
    unlinkSync(join(root, sensitiveFile));
    write(root, `${snapshotDir}/README.md`, '# 重录确认\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('只动快照目录自身不触发敏感面判定（豁免）', () => {
    const root = makeFixture();
    unlinkSync(join(root, caseIndex));
    write(root, `${snapshotDir}/single-turn-qa/index.json`, '{"version":1,"caseId":"single-turn-qa","turns":["turn-02"]}\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('快照目录没有任何用例时 fail-loud（门不许空转）', () => {
    const root = makeFixture();
    // 目录还在、用例的 index.json 没了 ⇒ 0 条用例，不许扫空假绿
    unlinkSync(join(root, caseIndex));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('没有任何用例');
  });

  it('已提交的敏感面变更（merge-base 口径）不同步快照时必须红', () => {
    const root = makeFixture();
    const baseRef = git(root, 'rev-parse', 'HEAD');
    write(root, sensitiveFile, 'export const SYSTEM_PROMPT = "v2";\n');
    git(root, 'add', sensitiveFile);
    git(root, 'commit', '-qm', 'change prompt without re-record');

    const result = runGate(root, baseRef);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('改了模型可见行为面但没同 PR 重录 request-replay 快照');
  });
});
