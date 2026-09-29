// N-CHECKPOINT-WRITETARGET 集成测试：middleware 真入口 + 真 FileCheckpointService + 真回退。
// 不 mock checkpoint service——getDatabase 指到内存 SQLite，Bash 效果用真 shell 落盘。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type BetterSqlite3 from 'better-sqlite3';

const databaseState = vi.hoisted(() => ({ service: null as null | {
  isReady: boolean;
  getDb: () => BetterSqlite3.Database;
} }));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => databaseState.service,
}));

import { applySchema } from '../../../src/host/services/core/database/schema';
import { applySessionsMigrations } from '../../../src/host/services/core/database/migrations';
import { FileCheckpointService } from '../../../src/host/services/checkpoint/fileCheckpointService';
import { createFileCheckpointIfNeeded } from '../../../src/host/tools/middleware/fileCheckpointMiddleware';
import { bashSchema } from '../../../src/host/tools/modules/shell/bash.schema';
import { docxGenerateSchema } from '../../../src/host/tools/modules/network/docxGenerate.schema';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { ToolSchema } from '../../../src/host/protocol/tools';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

// 照生产 adapter（dispatch/toolDefinitions.ts schemaToDefinition）的映射形状取字段：
// middleware 消费 name/permissionLevel/pathAuthority，schema 直译不带多余字段。
function toDefinition(schema: ToolSchema): ToolDefinition {
  return {
    name: schema.name,
    description: schema.description,
    inputSchema: schema.inputSchema as unknown as ToolDefinition['inputSchema'],
    outputSchema: schema.outputSchema as unknown as ToolDefinition['outputSchema'],
    requiresPermission: schema.requiresPermission ?? schema.permissionLevel !== 'read',
    permissionLevel: schema.permissionLevel === 'dangerous' ? 'execute' : schema.permissionLevel,
    pathAuthority: schema.pathAuthority,
  };
}

const bashDefinition = toDefinition(bashSchema);
const docxDefinition = toDefinition(docxGenerateSchema);

// 无 annotations 的 MCP 工具走 mapMcpAnnotationsToPermission 的兜底档（permissionLevel
// 'network'，非 read），通用参数扫描按参数名认 path 类后缀。
const mcpDefinition: ToolDefinition = {
  name: 'mcp__filesystem__write_text_file',
  description: 'MCP fixture: writes text content to a path',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  requiresPermission: true,
  permissionLevel: 'network',
};

const readDefinition: ToolDefinition = {
  name: 'read_file',
  description: 'Fixture: read-only tool with a path parameter',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'string' },
  requiresPermission: false,
  permissionLevel: 'read',
};

async function runShell(command: string, cwd?: string): Promise<void> {
  execFileSync('sh', ['-c', command], { cwd, encoding: 'utf-8', stdio: 'pipe' });
}

async function runShellWithEnv(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
  execFileSync('sh', ['-c', command], { cwd, encoding: 'utf-8', stdio: 'pipe', env: { ...process.env, ...env } });
}

describe('fileCheckpointMiddleware write-target snapshots (integration)', () => {
  let db: BetterSqlite3.Database;
  let service: FileCheckpointService;
  let tempDir: string;
  const sessionId = 'session-write-target';
  const messageId = 'tool-call-1';

  beforeEach(async () => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    applySchema(db, logger);
    applySessionsMigrations(db, logger);
    databaseState.service = { isReady: true, getDb: () => db };
    service = new FileCheckpointService();
    const now = Date.now();
    db.prepare(`
      INSERT INTO sessions (
        id, title, model_provider, model_name, session_type,
        created_at, updated_at, status, is_deleted
      ) VALUES (?, 'WriteTarget', 'openai', 'gpt-5', 'chat', ?, ?, 'idle', 0)
    `).run(sessionId, now, now);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-write-target-'));
  });

  afterEach(async () => {
    databaseState.service = null;
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function context(): { sessionId: string; messageId: string } {
    return { sessionId, messageId };
  }

  async function snapshotAndFinalize(
    definition: ToolDefinition,
    params: Record<string, unknown>,
    afterExecute: () => Promise<void>,
  ): Promise<ReturnType<typeof createFileCheckpointIfNeeded>> {
    const checkpoints = await createFileCheckpointIfNeeded(definition, params, context, tempDir);
    await afterExecute();
    for (const checkpoint of checkpoints) {
      await service.finalizeCheckpointDigest(checkpoint.checkpointId, checkpoint.filePath);
    }
    return checkpoints;
  }

  it('snapshots a Bash redirection target with existing content and restores it on rewind', async () => {
    const file = path.join(tempDir, 'a.txt');
    await fs.writeFile(file, 'original\n', 'utf-8');
    const command = `echo changed > ${file}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(file));

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(await fs.readFile(file, 'utf-8')).toBe('original\n');
  });

  it('snapshots a Bash-created file that did not exist and deletes it on rewind', async () => {
    const file = path.join(tempDir, 'brand-new.txt');
    const command = `echo brand-new > ${file}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints).toHaveLength(1);
    expect(await fs.readFile(file, 'utf-8')).toBe('brand-new\n');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.deletedFiles).toEqual([checkpoints[0].filePath]);
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('anchors a relative Bash redirection to params.working_directory, not the session cwd', async () => {
    const sub = path.join(tempDir, 'sub');
    await fs.mkdir(sub);
    const command = 'echo anchored > out.txt';

    const checkpoints = await snapshotAndFinalize(
      bashDefinition,
      { command, working_directory: sub },
      () => runShell(command, sub),
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(path.join(sub, 'out.txt')));

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.deletedFiles).toEqual([checkpoints[0].filePath]);
    await expect(fs.access(path.join(sub, 'out.txt'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('creates a single deduplicated checkpoint when one target is written repeatedly', async () => {
    const file = path.join(tempDir, 'repeat.txt');
    const command = `echo one > ${file}; echo two >> ${file}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints).toHaveLength(1);
  });

  it('does not snapshot /dev/null redirections', async () => {
    const checkpoints = await createFileCheckpointIfNeeded(
      bashDefinition,
      { command: 'echo x > /dev/null' },
      context,
      tempDir,
    );
    expect(checkpoints).toEqual([]);
  });

  it('snapshots an MCP tool write through its path-like parameter and restores it on rewind', async () => {
    const file = path.join(tempDir, 'mcp-note.txt');
    await fs.writeFile(file, 'before-mcp\n', 'utf-8');
    const params = { path: file, content: 'after-mcp\n' };

    const checkpoints = await snapshotAndFinalize(mcpDefinition, params, () =>
      fs.writeFile(file, 'after-mcp\n', 'utf-8'));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(file));

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(await fs.readFile(file, 'utf-8')).toBe('before-mcp\n');
  });

  it('snapshots a document-generation tool through its declared output_path and restores it on rewind', async () => {
    const file = path.join(tempDir, 'report.docx');
    await fs.writeFile(file, 'before-docx\n', 'utf-8');
    const params = { title: 't', content: 'c', output_path: file };

    const checkpoints = await snapshotAndFinalize(docxDefinition, params, () =>
      fs.writeFile(file, 'after-docx\n', 'utf-8'));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(file));

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(await fs.readFile(file, 'utf-8')).toBe('before-docx\n');
  });

  it('records uncertain redirection targets and reports them in rewind skippedFiles', async () => {
    const checkpoints = await createFileCheckpointIfNeeded(
      bashDefinition,
      { command: 'echo x > "$OUT"/a.txt' },
      context,
      tempDir,
    );
    expect(checkpoints).toEqual([]);

    const rows = db.prepare(
      'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ?',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
    expect(rows).toEqual([
      { file_path: 'uncertain-redirection:$OUT/a.txt', uncertain_target: 1 },
    ]);

    // 列表/预览面不把 uncertain 记录当快照展示
    expect(await service.getCheckpoints(sessionId)).toEqual([]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.skippedFiles).toEqual([{
      filePath: 'uncertain-redirection:$OUT/a.txt',
      reason: 'uncertain_write_target',
      detail: 'The write target could not be resolved when the tool ran, so no snapshot exists to restore.',
    }]);
    expect(rewind.success).toBe(false);
  });

  it('keeps the tool call unblocked when write-target resolution throws (fail-open)', async () => {
    // 自指符号链接让 resolveCanonicalRunPath 触发环深上限抛错；检查点侧必须吞掉
    await fs.symlink(path.join(tempDir, 'loop'), path.join(tempDir, 'loop'));
    const checkpoints = await createFileCheckpointIfNeeded(
      bashDefinition,
      { command: `echo x > ${path.join(tempDir, 'loop', 'f.txt')}` },
      context,
      tempDir,
    );
    expect(checkpoints).toEqual([]);
  });

  it('skips read-permission tools entirely', async () => {
    const file = path.join(tempDir, 'read-only.txt');
    const checkpoints = await createFileCheckpointIfNeeded(
      readDefinition,
      { file_path: file },
      context,
      tempDir,
    );
    expect(checkpoints).toEqual([]);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });
  });

  // ---- 返修 r1：移动/重命名类操作的源与目的地一起进快照 ----
  // 只快照 mv 的目的地，回退时目的地被删/回写而源无人恢复 → 内容从工作区彻底消失。

  it('snapshots both sides of a Bash mv and restores the source when the destination did not exist', async () => {
    const source = path.join(tempDir, 'notes.md');
    await fs.writeFile(source, 'notes-content\n', 'utf-8');
    const target = path.join(tempDir, 'archive.md');
    const command = `mv ${source} ${target}`;

    // 目的地原不存在：期望路径 = 父目录 realpath + 文件名（resolveCanonicalRunPath 口径）
    const realSource = await fs.realpath(source);
    const realTarget = path.join(await fs.realpath(tempDir), 'archive.md');
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints.map((checkpoint) => checkpoint.filePath).sort())
      .toEqual([realSource, realTarget].sort());
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(target, 'utf-8')).toBe('notes-content\n');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([realSource]);
    expect(rewind.deletedFiles).toEqual([realTarget]);
    expect(await fs.readFile(source, 'utf-8')).toBe('notes-content\n');
    await expect(fs.access(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots both sides of a Bash mv and restores both files when the destination existed', async () => {
    const source = path.join(tempDir, 'notes.md');
    await fs.writeFile(source, 'notes-content\n', 'utf-8');
    const target = path.join(tempDir, 'archive.md');
    await fs.writeFile(target, 'archive-original\n', 'utf-8');
    const command = `mv ${source} ${target}`;

    const [realSource, realTarget] = await Promise.all([fs.realpath(source), fs.realpath(target)]);
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints.map((checkpoint) => checkpoint.filePath).sort()).toEqual([realSource, realTarget].sort());

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.sort()).toEqual([realSource, realTarget].sort());
    expect(await fs.readFile(source, 'utf-8')).toBe('notes-content\n');
    expect(await fs.readFile(target, 'utf-8')).toBe('archive-original\n');
  });

  it('snapshots the source of an MCP move_file call and restores both files on rewind', async () => {
    const source = path.join(tempDir, 'mcp-notes.md');
    await fs.writeFile(source, 'mcp-notes-content\n', 'utf-8');
    const target = path.join(tempDir, 'mcp-archive.md');
    await fs.writeFile(target, 'mcp-archive-original\n', 'utf-8');
    const moveDefinition: ToolDefinition = {
      name: 'mcp__filesystem__move_file',
      description: 'MCP fixture: moves a file from source to destination',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      requiresPermission: true,
      permissionLevel: 'network',
    };
    const params = { source, destination: target };

    const [realSource, realTarget] = await Promise.all([fs.realpath(source), fs.realpath(target)]);
    const checkpoints = await snapshotAndFinalize(moveDefinition, params, () => fs.rename(source, target));
    expect(checkpoints.map((checkpoint) => checkpoint.filePath).sort())
      .toEqual([realSource, realTarget].sort());

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.sort()).toEqual([realSource, realTarget].sort());
    expect(await fs.readFile(source, 'utf-8')).toBe('mcp-notes-content\n');
    expect(await fs.readFile(target, 'utf-8')).toBe('mcp-archive-original\n');
  });

  it('snapshots every source of a multi-source mv into a directory and restores them', async () => {
    const first = path.join(tempDir, 'multi-a.md');
    const second = path.join(tempDir, 'multi-b.md');
    await fs.writeFile(first, 'multi-a-content\n', 'utf-8');
    await fs.writeFile(second, 'multi-b-content\n', 'utf-8');
    const dir = path.join(tempDir, 'dir');
    await fs.mkdir(dir);
    const command = `mv multi-a.md multi-b.md dir/`;

    const [realFirst, realSecond] = await Promise.all([fs.realpath(first), fs.realpath(second)]);
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints.map((checkpoint) => checkpoint.filePath).sort())
      .toEqual([realFirst, realSecond].sort());

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.sort()).toEqual([realFirst, realSecond].sort());
    expect(await fs.readFile(first, 'utf-8')).toBe('multi-a-content\n');
    expect(await fs.readFile(second, 'utf-8')).toBe('multi-b-content\n');
  });

  it('treats a Bash mv with an unresolvable source as uncertain and rewinds nothing', async () => {
    const source = path.join(tempDir, 'vanishing.md');
    await fs.writeFile(source, 'vanishing-content\n', 'utf-8');
    const target = path.join(tempDir, 'survivor.md');
    await fs.writeFile(target, 'survivor-original\n', 'utf-8');
    // middleware 只看到带变量的命令，解析不出源 —— 与真实执行同一形状
    const command = 'mv "$SRC" survivor.md';

    const checkpoints = await snapshotAndFinalize(
      bashDefinition,
      { command },
      () => runShellWithEnv(command, tempDir, { SRC: source }),
    );
    expect(checkpoints).toEqual([]);
    expect(await fs.readFile(target, 'utf-8')).toBe('vanishing-content\n');

    // 没有真快照行：一个 uncertain 披露行，不建「只快照一半」的目的地快照
    const rows = db.prepare(
      'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ? ORDER BY file_path',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
    expect(rows).toEqual([
      { file_path: 'uncertain-move:mv "$SRC" survivor.md', uncertain_target: 1 },
    ]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.skippedFiles).toEqual([{
      filePath: 'uncertain-move:mv "$SRC" survivor.md',
      reason: 'uncertain_write_target',
      detail: 'The write target could not be resolved when the tool ran, so no snapshot exists to restore.',
    }]);
    // 回退不碰：survivor.md 保持执行后状态（与 origin/main 的 Bash 行为一致）
    expect(await fs.readFile(target, 'utf-8')).toBe('vanishing-content\n');
  });
});
