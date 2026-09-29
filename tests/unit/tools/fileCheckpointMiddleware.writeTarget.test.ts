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
});
