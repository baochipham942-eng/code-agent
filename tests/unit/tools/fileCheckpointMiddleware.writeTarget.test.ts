// N-CHECKPOINT-WRITETARGET 集成测试：middleware 真入口 + 真 FileCheckpointService + 真回退。
// 不 mock checkpoint service——getDatabase 指到内存 SQLite，Bash 效果用真 shell 落盘。
// 返修 r4 口径：移动/重命名类（mv）与 MCP/未知工具的写目标推断退出回退——mv 零快照、
// 回退不碰两侧；MCP 回 origin/main 行为（不建快照）；保留重定向 / cp 目的地 / rm 目标 /
// tee 与内置写工具 schema 声明的写路径，每条快照单文件单行自足可回退。
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
import { writeSchema } from '../../../src/host/tools/modules/file/write.schema';
import { multiEditSchema } from '../../../src/host/tools/modules/file/multiEdit.schema';
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
const writeDefinition = toDefinition(writeSchema);
const editDefinition = toDefinition(multiEditSchema);

// 无 annotations 的 MCP 工具走 mapMcpAnnotationsToPermission 的兜底档（permissionLevel
// 'network'，非 read）。返修 r4 起 MCP / 未知工具不推断写目标（回 origin/main 行为）：
// 这个 fixture 钉住「连写字段形状（path）也不建快照」。
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

  it('snapshots a Bash cp destination and restores it on rewind', async () => {
    const src = path.join(tempDir, 'src.txt');
    await fs.writeFile(src, 'incoming\n', 'utf-8');
    const dst = path.join(tempDir, 'dst.md');
    await fs.writeFile(dst, 'before-cp\n', 'utf-8');
    const command = `cp ${src} ${dst}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(dst));
    expect(await fs.readFile(dst, 'utf-8')).toBe('incoming\n');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(await fs.readFile(dst, 'utf-8')).toBe('before-cp\n');
    expect(await fs.readFile(src, 'utf-8')).toBe('incoming\n');
  });

  it('snapshots a Bash rm target and restores the deleted file on rewind', async () => {
    const file = path.join(tempDir, 'doomed.txt');
    await fs.writeFile(file, 'precious\n', 'utf-8');
    const realFile = await fs.realpath(file);
    const command = `rm ${file}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(realFile);
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(await fs.readFile(file, 'utf-8')).toBe('precious\n');
  });

  it('snapshots built-in Write and Edit tools through their declared file_path and restores them', async () => {
    const writeTarget = path.join(tempDir, 'write-note.md');
    await fs.writeFile(writeTarget, 'before-write\n', 'utf-8');
    const writeCheckpoints = await snapshotAndFinalize(
      writeDefinition,
      { file_path: writeTarget, content: 'after-write\n' },
      () => fs.writeFile(writeTarget, 'after-write\n', 'utf-8'),
    );
    expect(writeCheckpoints).toHaveLength(1);
    expect(writeCheckpoints[0].filePath).toBe(await fs.realpath(writeTarget));

    const editTarget = path.join(tempDir, 'edit-note.md');
    await fs.writeFile(editTarget, 'before-edit\n', 'utf-8');
    const editCheckpoints = await snapshotAndFinalize(
      editDefinition,
      { file_path: editTarget, old_string: 'before', new_string: 'after' },
      () => fs.writeFile(editTarget, 'after-edit\n', 'utf-8'),
    );
    expect(editCheckpoints).toHaveLength(1);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.map((filePath) => path.basename(filePath)).sort())
      .toEqual(['edit-note.md', 'write-note.md']);
    expect(await fs.readFile(writeTarget, 'utf-8')).toBe('before-write\n');
    expect(await fs.readFile(editTarget, 'utf-8')).toBe('before-edit\n');
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

  // ---- 返修 r4：移动/重命名类一律不进回退（与 origin/main 一致：不建快照、回退不碰）----

  it('keeps Bash mv entirely out of rollback: no snapshots and rewind touches neither side', async () => {
    const source = path.join(tempDir, 'notes.md');
    await fs.writeFile(source, 'notes-content\n', 'utf-8');
    const target = path.join(tempDir, 'archive.md');
    // 多源 mv（含目的地目录形状）同样零快照
    const multiDir = path.join(tempDir, 'dest-dir');
    await fs.mkdir(multiDir);
    const first = path.join(tempDir, 'multi-a.md');
    await fs.writeFile(first, 'multi-a\n', 'utf-8');
    const second = path.join(tempDir, 'multi-b.md');
    await fs.writeFile(second, 'multi-b\n', 'utf-8');
    // 同一命令带一个会建快照的重定向：回退机器真的跑起来，mv 的两侧不在任何窗口里
    const other = path.join(tempDir, 'other.txt');
    const command = `mv ${source} ${target}; mv ${first} ${second} ${multiDir}/; echo z > ${other}`;

    const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
    expect(checkpoints.map((checkpoint) => path.basename(checkpoint.filePath))).toEqual(['other.txt']);
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(target, 'utf-8')).toBe('notes-content\n');
    expect(await fs.readFile(path.join(multiDir, 'multi-a.md'), 'utf-8')).toBe('multi-a\n');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.deletedFiles.map((filePath) => path.basename(filePath))).toEqual(['other.txt']);
    await expect(fs.access(other)).rejects.toMatchObject({ code: 'ENOENT' });
    // 回退不碰 mv 的任何一侧：源保持移走、目的地保持移动后内容（与 origin/main 一致）
    await expect(fs.access(source)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await fs.readFile(target, 'utf-8')).toBe('notes-content\n');
    expect(await fs.readFile(path.join(multiDir, 'multi-a.md'), 'utf-8')).toBe('multi-a\n');
    expect(await fs.readFile(path.join(multiDir, 'multi-b.md'), 'utf-8')).toBe('multi-b\n');
  });

  // ---- 返修 r4：MCP / 未知工具的写目标推断删除（回 origin/main 行为，不建快照）----

  it('returns MCP and unknown tools to main behavior: no write-target inference at all', async () => {
    const file = path.join(tempDir, 'mcp-note.txt');
    await fs.writeFile(file, 'before-mcp\n', 'utf-8');
    const moveDefinition: ToolDefinition = {
      name: 'mcp__filesystem__move_file',
      description: 'MCP fixture: moves a file from source to destination',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      requiresPermission: true,
      permissionLevel: 'network',
    };
    // move 形状（source+destination）与写字段形状（path）都不再推断：MCP 写盘工具
    // 回到「不建快照」，回退不碰（turnCheckout 的差额披露口径不变）
    const moveCheckpoints = await createFileCheckpointIfNeeded(
      moveDefinition,
      { source: file, destination: path.join(tempDir, 'moved.md') },
      context,
      tempDir,
    );
    expect(moveCheckpoints).toEqual([]);
    const writeCheckpoints = await createFileCheckpointIfNeeded(
      mcpDefinition,
      { path: file, content: 'after-mcp\n' },
      context,
      tempDir,
    );
    expect(writeCheckpoints).toEqual([]);
    expect(db.prepare(
      'SELECT COUNT(*) AS count FROM file_checkpoints WHERE session_id = ?',
    ).get(sessionId)).toEqual({ count: 0 });
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

  it('reports uncertain_write_target (not human_edit) when an unsnapshotable write follows a real snapshot', async () => {
    const file = path.join(tempDir, 'story.md');
    await fs.writeFile(file, 'v1\n', 'utf-8');
    const first = await snapshotAndFinalize(
      bashDefinition,
      { command: `echo v2 > ${file}` },
      () => runShell(`echo v2 > ${file}`),
    );
    expect(first).toHaveLength(1);
    // 第二次写入时文件已是二进制：建不出无损快照 → 该真实路径落披露行
    await fs.writeFile(file, BINARY_PNG_BYTES);
    const second = await snapshotAndFinalize(
      bashDefinition,
      { command: `echo v3 > ${file}` },
      () => runShell(`echo v3 > ${file}`),
    );
    expect(second).toEqual([]);

    // 回退：窗口内同一路径既有真快照又有披露行——按披露口径回报（成因是第二次写入
    // 没快照，不是人工编辑），文件保持执行后内容
    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.skippedFiles).toEqual([{
      filePath: await fs.realpath(file),
      reason: 'uncertain_write_target',
      detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
    }]);
    expect(await fs.readFile(file, 'utf-8')).toBe('v3\n');
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

  // ---- 返修 r3 保留面：working_directory 不算写目标、uncertain 披露去重与上限 ----

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

  // ---- 返修 r4 不变量：每条快照单文件单行自足，被上限逐出的行其文件回退时不碰 ----

  it('leaves evicted snapshots untouched on rewind after the per-session limit', async () => {
    // middleware 走单例 service：把上限压到 3，一次调用建 4 个目标——最旧的 f1 被逐出
    initFileCheckpointService({ maxCheckpointsPerSession: 3 });
    try {
      const files = ['f1.txt', 'f2.txt', 'f3.txt', 'f4.txt'].map((name) => path.join(tempDir, name));
      for (const file of files) await fs.writeFile(file, 'original\n', 'utf-8');
      const realFiles = await Promise.all(files.map((file) => fs.realpath(file)));
      const command = files.map((file) => `echo rewritten > ${file}`).join('; ');

      const checkpoints = await snapshotAndFinalize(bashDefinition, { command }, () => runShell(command));
      // middleware 拿到 4 个 id，但库里只剩 3 行：f1 在 f4 建行时被上限逐出
      expect(checkpoints).toHaveLength(4);
      const rows = db.prepare(
        'SELECT file_path FROM file_checkpoints WHERE session_id = ? AND COALESCE(uncertain_target, 0) = 0',
      ).all(sessionId) as Array<{ file_path: string }>;
      expect(rows.map((row) => row.file_path).sort())
        .toEqual([realFiles[1], realFiles[2], realFiles[3]].sort());

      const rewind = await service.rewindFiles(sessionId, messageId);
      // 存活的三行照常回退
      expect(rewind.restoredFiles.sort()).toEqual([realFiles[1], realFiles[2], realFiles[3]].sort());
      for (const file of [files[1], files[2], files[3]]) {
        expect(await fs.readFile(file, 'utf-8')).toBe('original\n');
      }
      // 被逐出的 f1 不被删除也不被改写：回退窗口里根本没有它的行（单行自足不变量）
      expect(rewind.restoredFiles).not.toContain(realFiles[0]);
      expect(rewind.deletedFiles).toEqual([]);
      expect(await fs.readFile(files[0], 'utf-8')).toBe('rewritten\n');
      expect(rewind.skippedFiles).toEqual([]);
      expect(rewind.success).toBe(true);
    } finally {
      initFileCheckpointService();
    }
  });
});
