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
import { FileCheckpointService, initFileCheckpointService } from '../../../src/host/services/checkpoint/fileCheckpointService';
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

// PNG 魔数 + 无效 utf-8 字节（0xff/0xfe/0x81）：解码再编码回不去，是二进制判据的最小样本
const BINARY_PNG_BYTES = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff, 0xfe, 0x81,
]);

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

  it('snapshots an MCP tool write through its whitelisted path parameter and restores it on rewind', async () => {
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
      detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
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
      detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
    }]);
    // 回退不碰：survivor.md 保持执行后状态（与 origin/main 的 Bash 行为一致）
    expect(await fs.readFile(target, 'utf-8')).toBe('vanishing-content\n');
  });

  // ---- 返修 r2：移动的源与目的地必须成对建出无损快照，否则整次调用不进回退 ----
  // createCheckpoint 对超大/读错误返 null、对二进制按 utf-8 有损存入；只快照一半，
  // 回退会把目的地删掉而源无人恢复（或写回损坏内容）——文件从工作区永久丢失。

  it('keeps every file untouched when a Bash mv source exceeds the snapshot size limit', async () => {
    const source = path.join(tempDir, 'big.bin');
    await fs.writeFile(source, Buffer.alloc(1024 * 1024 + 1, 0x37));
    const outDir = path.join(tempDir, 'out');
    await fs.mkdir(outDir);
    const command = 'mv big.bin out/big.bin';

    const realSource = await fs.realpath(source);
    const realMoved = path.join(await fs.realpath(outDir), 'big.bin');
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });

    // 源与目的地都以 uncertain 披露行落库：没有半对快照
    const rows = db.prepare(
      'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ? ORDER BY file_path',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
    expect(rows).toEqual([
      { file_path: realSource, uncertain_target: 1 },
      { file_path: realMoved, uncertain_target: 1 },
    ]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.deletedFiles).toEqual([]);
    // 回退不碰：目的地字节原样（不被 unlink），源保持移走
    expect(await fs.readFile(realMoved)).toEqual(Buffer.alloc(1024 * 1024 + 1, 0x37));
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps every file untouched when a Bash mv source is binary (non utf-8)', async () => {
    const source = path.join(tempDir, 'logo.png');
    await fs.writeFile(source, BINARY_PNG_BYTES);
    const assetsDir = path.join(tempDir, 'assets');
    await fs.mkdir(assetsDir);
    const command = 'mv logo.png assets/';

    const realSource = await fs.realpath(source);
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);
    const moved = path.join(assetsDir, 'logo.png');
    expect(await fs.readFile(moved)).toEqual(BINARY_PNG_BYTES);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.deletedFiles).toEqual([]);
    // 回退不碰：二进制逐字节保持执行后状态，不被有损「快照」写回损坏内容
    expect(await fs.readFile(moved)).toEqual(BINARY_PNG_BYTES);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(rewind.skippedFiles.map((entry) => entry.filePath).sort())
      .toEqual([await fs.realpath(assetsDir), realSource].sort());
  });

  it('keeps every file untouched when a Bash mv source cannot be read', async () => {
    const source = path.join(tempDir, 'sealed.md');
    await fs.writeFile(source, 'sealed-content\n');
    await fs.chmod(source, 0o000);
    const command = 'mv sealed.md delivered.md';

    const realTarget = path.join(await fs.realpath(tempDir), 'delivered.md');
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);
    // rename 只需要目录权限：移动照常发生（rename 保留 mode，先恢复可读再断言）
    await fs.chmod(realTarget, 0o644);
    expect(await fs.readFile(realTarget, 'utf-8')).toBe('sealed-content\n');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.deletedFiles).toEqual([]);
    // 回退不碰：目的地保持执行后内容，源保持移走
    expect(await fs.readFile(realTarget, 'utf-8')).toBe('sealed-content\n');
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.chmod(realTarget, 0o644);
  });

  it('keeps every file untouched when a Bash mv destination is binary (non utf-8)', async () => {
    const source = path.join(tempDir, 'small.txt');
    await fs.writeFile(source, 'small\n');
    const target = path.join(tempDir, 'logo.png');
    await fs.writeFile(target, BINARY_PNG_BYTES);
    const command = 'mv small.txt logo.png';

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.deletedFiles).toEqual([]);
    // 回退不碰：目的地保持移动后的文本，不被有损「快照」写回损坏的二进制
    expect(await fs.readFile(target, 'utf-8')).toBe('small\n');
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('opts the whole call out of rewind when one move pair cannot be snapshotted losslessly', async () => {
    const big = path.join(tempDir, 'big.bin');
    await fs.writeFile(big, Buffer.alloc(1024 * 1024 + 1, 0x41));
    const outDir = path.join(tempDir, 'out');
    await fs.mkdir(outDir);
    const command = 'mv big.bin out/big.bin; echo y > c.txt';

    const realBig = await fs.realpath(big);
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);
    const clean = path.join(tempDir, 'c.txt');
    expect(await fs.readFile(clean, 'utf-8')).toBe('y\n');

    // 同一调用里干净的目标也整单不进回退（「整次调用不进回退」），但逐条披露
    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.deletedFiles).toEqual([]);
    expect(await fs.readFile(clean, 'utf-8')).toBe('y\n');
    expect(await fs.readFile(path.join(outDir, 'big.bin'))).toEqual(Buffer.alloc(1024 * 1024 + 1, 0x41));
    expect(rewind.skippedFiles.map((entry) => entry.filePath).sort()).toEqual([
      path.join(await fs.realpath(tempDir), 'c.txt'),
      path.join(await fs.realpath(outDir), 'big.bin'),
      realBig,
    ].sort());
  });

  it('discloses instead of corrupting a binary file overwritten by a Bash redirection', async () => {
    const file = path.join(tempDir, 'logo.png');
    await fs.writeFile(file, BINARY_PNG_BYTES);
    const command = 'echo x > logo.png';

    const realFile = await fs.realpath(file);
    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
    expect(checkpoints).toEqual([]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    // 回退不把 utf-8 有损读入的「快照」写回二进制文件：保持执行后内容并逐条披露
    expect(await fs.readFile(file)).toEqual(Buffer.from('x\n'));
    expect(rewind.skippedFiles).toEqual([{
      filePath: realFile,
      reason: 'uncertain_write_target',
      detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
    }]);
  });

  it('evicts only real snapshots at the per-session limit; disclosures sit outside that budget', async () => {
    const limited = new FileCheckpointService({ maxCheckpointsPerSession: 3 });
    // 最旧的两行是 uncertain 披露：逐出时不得拿它们顶数（真快照数会持续超上限）
    await limited.recordUncertainWriteTarget(sessionId, 'msg-u1', 'uncertain-redirection:$A');
    await limited.recordUncertainWriteTarget(sessionId, 'msg-u2', 'uncertain-redirection:$B');
    for (const name of ['one.md', 'two.md', 'three.md']) {
      const id = await limited.createCheckpoint(sessionId, 'msg-real', path.join(tempDir, name));
      expect(id).not.toBeNull();
    }
    // 第 4 个真快照触发逐出：被删的是最旧的真快照（one.md），披露行原样保留
    await limited.createCheckpoint(sessionId, 'msg-real', path.join(tempDir, 'four.md'));
    const rows = db.prepare(
      'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ? ORDER BY file_path',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
    expect(rows).toEqual([
      { file_path: path.join(tempDir, 'four.md'), uncertain_target: 0 },
      { file_path: path.join(tempDir, 'three.md'), uncertain_target: 0 },
      { file_path: path.join(tempDir, 'two.md'), uncertain_target: 0 },
      { file_path: 'uncertain-redirection:$A', uncertain_target: 1 },
      { file_path: 'uncertain-redirection:$B', uncertain_target: 1 },
    ]);
  });

  // ---- 返修 r3：写目标只认白名单来源，uncertain 披露有界 ----
  // 通用 path-like 后缀扫描把 Bash 的 working_directory（目录）当写目标：建不出快照，
  // 每次带 working_directory 的 Bash 调用（哪怕 ls）都落一条 uncertain 披露行，
  // turn checkout 从 success 变 partial，且披露行无上限增长。

  it('keeps read-only Bash calls with working_directory free of snapshots and disclosures', async () => {
    const sub = path.join(tempDir, 'sub');
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, 'note.txt'), 'x\n', 'utf-8');
    for (const command of ['ls -la', 'cat note.txt', 'git status']) {
      const checkpoints = await createFileCheckpointIfNeeded(
        bashDefinition,
        { command, working_directory: sub },
        context,
        tempDir,
      );
      expect(checkpoints).toEqual([]);
    }
    // 零快照行 + 零 uncertain 披露行：turn checkout 的 fileFailures（errors +
    // skippedFiles）无从产生，轮次状态保持 success
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });
  });

  it('snapshots only the mv operands when working_directory is set, never the directory itself', async () => {
    const sub = path.join(tempDir, 'cwd');
    await fs.mkdir(sub);
    const source = path.join(sub, 'a.md');
    await fs.writeFile(source, 'a-content\n', 'utf-8');
    const command = 'mv a.md b.md';

    const realSource = await fs.realpath(source);
    const realTarget = path.join(await fs.realpath(sub), 'b.md');
    const checkpoints = await snapshotAndFinalize(
      bashDefinition,
      { command, working_directory: sub },
      () => runShell(command, sub),
    );
    expect(checkpoints.map((checkpoint) => checkpoint.filePath).sort())
      .toEqual([realSource, realTarget].sort());
    const rows = db.prepare(
      'SELECT file_path FROM file_checkpoints WHERE session_id = ? AND COALESCE(uncertain_target, 0) = 0',
    ).all(sessionId) as Array<{ file_path: string }>;
    expect(rows.map((row) => row.file_path).sort()).toEqual([realSource, realTarget].sort());
  });

  it('ignores path-like MCP parameters that are not on the write-target whitelist', async () => {
    const sub = path.join(tempDir, 'mcp-dir');
    await fs.mkdir(sub);
    // 旧后缀扫描会把 directory（后缀命中）当写目标；白名单只认
    // path/file_path/destination/dest，其余参数一概不是写目标
    const checkpoints = await createFileCheckpointIfNeeded(
      mcpDefinition,
      { directory: sub, cwd: sub, timeout_ms: 30000 },
      context,
      tempDir,
    );
    expect(checkpoints).toEqual([]);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });
  });

  it('records a repeated uncertain target once, not once per tool call', async () => {
    await createFileCheckpointIfNeeded(
      bashDefinition,
      { command: 'echo x > "$OUT"/a.txt' },
      context,
      tempDir,
    );
    await createFileCheckpointIfNeeded(
      bashDefinition,
      { command: 'echo y > "$OUT"/a.txt; echo z > "$OUT"/a.txt' },
      () => ({ sessionId, messageId: 'tool-call-2' }),
      tempDir,
    );
    const rows = db.prepare(
      'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ?',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
    expect(rows).toEqual([
      { file_path: 'uncertain-redirection:$OUT/a.txt', uncertain_target: 1 },
    ]);
  });

  it('bounds uncertain disclosures with their own budget instead of growing forever', async () => {
    const limited = new FileCheckpointService({ maxCheckpointsPerSession: 3 });
    for (const key of ['$A', '$B', '$C', '$D', '$E']) {
      await limited.recordUncertainWriteTarget(sessionId, `msg-${key}`, `uncertain-redirection:${key}`);
    }
    const rows = db.prepare(
      'SELECT file_path FROM file_checkpoints WHERE session_id = ? ORDER BY file_path',
    ).all(sessionId) as Array<{ file_path: string }>;
    expect(rows.map((row) => row.file_path)).toEqual([
      'uncertain-redirection:$C',
      'uncertain-redirection:$D',
      'uncertain-redirection:$E',
    ]);
  });

  it('never leaves half a move pair when the per-session limit evicts mid-call', async () => {
    // middleware 走单例 service：把上限压到 2，一次调用建 3 个目标（配对 a/b + 独立 c），
    // 调用中途的 enforceLimit 逐出只许吃掉非配对行——配对整对存活，或整单撤下披露
    initFileCheckpointService({ maxCheckpointsPerSession: 2 });
    try {
      const source = path.join(tempDir, 'pair-a.md');
      await fs.writeFile(source, 'pair-a\n', 'utf-8');
      const command = 'mv pair-a.md pair-b.md; echo x > pair-c.txt';

      const realSource = await fs.realpath(source);
      const realTarget = path.join(await fs.realpath(tempDir), 'pair-b.md');
      const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command, tempDir));
      expect(checkpoints.map((checkpoint) => checkpoint.filePath)).toEqual(expect.arrayContaining([realSource, realTarget]));

      const rows = db.prepare(
        'SELECT file_path, uncertain_target FROM file_checkpoints WHERE session_id = ? ORDER BY file_path',
      ).all(sessionId) as Array<{ file_path: string; uncertain_target: number }>;
      // 配对整对存活：被上限挤掉的只能是非配对行（pair-c），没有 uncertain 披露
      expect(rows).toEqual([
        { file_path: realSource, uncertain_target: 0 },
        { file_path: realTarget, uncertain_target: 0 },
      ].sort((left, right) => left.file_path.localeCompare(right.file_path)));
    } finally {
      initFileCheckpointService();
    }
  });
});
