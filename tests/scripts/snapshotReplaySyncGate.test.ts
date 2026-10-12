import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const gateScript = resolve('scripts/ci/snapshot-replay-sync-gate.mjs');
const roots: string[] = [];
const snapshotDir = 'packages/internal/evaluation-center/snapshots/request-replay';
const caseIndex = `${snapshotDir}/single-turn-qa/index.json`;
// 门钉的三层用例（THREE_LAYER_CASES）：fixture 必须与真仓同形——用例目录 + 两个旁路都在。
const threeLayerCaseId = 'write-file';
const threeLayerCaseIndex = `${snapshotDir}/${threeLayerCaseId}/index.json`;
const renderSidecar = `${snapshotDir}/${threeLayerCaseId}.render.json`;
const stateSidecar = `${snapshotDir}/${threeLayerCaseId}.state.json`;
const sensitiveFile = 'src/host/prompts/builder.ts';
const readProjectionFile = 'src/host/context/readResultProjection.ts';
const contextBuilderFile = 'src/host/agent/messageHandling/contextBuilder.ts';
const converterFile = 'src/host/agent/messageHandling/converter.ts';
const toolDefinitionsFile = 'src/host/tools/dispatch/toolDefinitions.ts';
const deferredToolsFile = 'src/host/services/toolSearch/deferredTools.ts';
const todayAnchorFile = 'src/shared/todayAnchor.ts';
const toolSchemaFile = 'src/host/tools/modules/file/read.schema.ts';
const provenSensitiveFiles = [
  contextBuilderFile,
  converterFile,
  toolDefinitionsFile,
  deferredToolsFile,
  todayAnchorFile,
  toolSchemaFile,
];

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
  write(root, readProjectionFile, 'export const READ_RECEIPT_PREFIX = "[Read already shown";\n');
  for (const file of provenSensitiveFiles) {
    write(root, file, 'export const MARKER = "v1";\n');
  }
  write(root, caseIndex, '{"version":1,"caseId":"single-turn-qa","turns":["turn-01"]}\n');
  write(root, threeLayerCaseIndex, '{"version":1,"caseId":"write-file","turns":["turn-01","turn-02"]}\n');
  write(root, renderSidecar, '{"caseId":"write-file","layer":"render"}\n');
  write(root, stateSidecar, '{"caseId":"write-file","layer":"state"}\n');
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

  it('改 Read 去重投影（src/host/context/readResultProjection.ts）不同步快照时必须红', () => {
    // N-SNAPSHOT-CORPUS-READDEDUPE：该文件不在 contextAssembly/ 前缀下，曾实测
    // 漏网——去重分支被变异时回放层不红，只能靠本门强制同 PR 重录语料。
    const root = makeFixture();
    write(root, readProjectionFile, 'export const READ_RECEIPT_PREFIX = "[Read duped";\n');

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('改了模型可见行为面但没同 PR 重录 request-replay 快照');
    expect(result.stderr).toContain(readProjectionFile);
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
    // 目录还在、用例的 index.json 没了 ⇒ 0 条用例，不许扫空假绿（两条用例都清）
    unlinkSync(join(root, caseIndex));
    unlinkSync(join(root, threeLayerCaseIndex));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('没有任何用例');
  });

  it('三层回放用例不在语料时必须红（旁路不算可有可无的附件）', () => {
    const root = makeFixture();
    // index.json 没了 ⇒ write-file 掉出用例名录，但 single-turn-qa 还在，语料非空
    unlinkSync(join(root, threeLayerCaseIndex));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`三层回放用例 ${threeLayerCaseId} 不在快照语料里`);
  });

  it('三层回放用例缺渲染层旁路时必须红', () => {
    const root = makeFixture();
    unlinkSync(join(root, renderSidecar));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('三层回放旁路缺失');
    expect(result.stderr).toContain(renderSidecar);
  });

  it('三层回放用例缺持久层旁路时必须红', () => {
    const root = makeFixture();
    unlinkSync(join(root, stateSidecar));

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('三层回放旁路缺失');
    expect(result.stderr).toContain(stateSidecar);
  });

  it.each(provenSensitiveFiles)('改 %s 不同步快照时必须红', (file) => {
    const root = makeFixture();
    write(root, file, 'export const MARKER = "v2";\n');

    const result = runGate(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('改了模型可见行为面但没同 PR 重录 request-replay 快照');
    expect(result.stderr).toContain(file);
  });

  it.each(provenSensitiveFiles)('改 %s 且快照目录同改时为绿', (file) => {
    const root = makeFixture();
    write(root, file, 'export const MARKER = "v2";\n');
    write(root, caseIndex, '{"version":1,"caseId":"single-turn-qa","turns":["turn-01","turn-02"]}\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
  });

  it('改 tools/modules 下非 schema 实现文件不触发敏感面', () => {
    const root = makeFixture();
    write(root, 'src/host/tools/modules/file/read.ts', 'export function read() { return 1; }\n');

    const result = runGate(root);
    expect(result.status, result.stderr).toBe(0);
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
