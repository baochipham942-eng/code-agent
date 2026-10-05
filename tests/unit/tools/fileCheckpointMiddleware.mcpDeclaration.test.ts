// N-CHECKPOINT-MCP-WRITETARGET 集成测试：MCP 写目标只认 server 声明（决策 2026-09-30）。
// 真入口（middleware）+ 真 FileCheckpointService（内存 SQLite）+ 真回退：
// - 声明通道：metadata.annotations.writePathParameters（registry 从 tool._meta 提升）
// - 信任边界：MCP 声明目标只快照 workspace 范围内（无 scope 以执行基准目录为界）
// - 未声明写盘：MCP 非只读 / 内置 write|execute 无声明工具 → 回退时逐工具披露
//   `undeclared-tool:<name>`，reason 'undeclared_tool_write'，success 不翻红
// 参数名推断（path/file_path 猜测）被永久否决——inference-bait 用例钉住零推断。
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
import { createWorkspaceScope } from '../../../src/host/runtime/workspaceScope';
import { writeSchema } from '../../../src/host/tools/modules/file/write.schema';
import { bashSchema } from '../../../src/host/tools/modules/shell/bash.schema';
import type { ToolDefinition } from '../../../src/shared/contract';
import type { MCPToolAnnotations } from '../../../src/host/mcp/types';
import type { ToolSchema } from '../../../src/host/protocol/tools';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
} as unknown as Parameters<typeof applySchema>[1];

// registry 的 getToolDefinitions 给 def 挂的运行时字段（公开类型未暴露，窄化访问，
// 与 tests/unit/mcp/mcpToolRegistry.test.ts 同款口径）。
type MCPDefinitionMetadata = { metadata?: { annotations?: MCPToolAnnotations } };

function mcpDefinition(name: string, annotations?: MCPToolAnnotations): ToolDefinition {
  const definition: ToolDefinition = {
    name,
    description: `MCP fixture: ${name}`,
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    requiresPermission: true,
    // 无 annotations 的 MCP 工具走 mapMCPAnnotationsToPermission 兜底档（network，非 read）
    permissionLevel: 'network',
  };
  if (annotations) {
    (definition as ToolDefinition & MCPDefinitionMetadata).metadata = { annotations };
  }
  return definition;
}

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

const declaredMcpTool = mcpDefinition('mcp__fs__save_file', { writePathParameters: ['target'] });
const undeclaredMcpTool = mcpDefinition('mcp__fs__write_text_file');
// readOnlyHint + openWorldHint 的 MCP 工具落在 network 档但 readOnly=true（只读联网）
const readOnlyMcpTool: ToolDefinition = {
  ...mcpDefinition('mcp__fs__peek'),
  permissionLevel: 'network',
  readOnly: true,
};
const writeDefinition = toDefinition(writeSchema);
const bashDefinition = toDefinition(bashSchema);

describe('fileCheckpointMiddleware MCP-declared write targets (integration)', () => {
  let db: BetterSqlite3.Database;
  let service: FileCheckpointService;
  let tempDir: string;
  let outsideDir: string;
  const sessionId = 'session-mcp-declared';
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
      ) VALUES (?, 'McpDeclared', 'openai', 'gpt-5', 'chat', ?, ?, 'idle', 0)
    `).run(sessionId, now, now);
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-mcp-declared-'));
    outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ckpt-mcp-outside-'));
  });

  afterEach(async () => {
    databaseState.service = null;
    db.close();
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(outsideDir, { recursive: true, force: true });
  });

  function ctx(messageIdOverride = messageId): () => { sessionId: string; messageId: string } {
    return () => ({ sessionId, messageId: messageIdOverride });
  }

  function rows(): Array<{ file_path: string; uncertain_target: number; message_id: string }> {
    return db.prepare(
      'SELECT file_path, uncertain_target, message_id FROM file_checkpoints WHERE session_id = ? ORDER BY rowid',
    ).all(sessionId) as Array<{ file_path: string; uncertain_target: number; message_id: string }>;
  }

  // 快照 → 真实写入 → 补写后摘要（toolExecutor 执行成功后收 digest 的同款步骤）
  async function snapshotWriteFinalize(
    definition: ToolDefinition,
    params: Record<string, unknown>,
    afterExecute: () => Promise<void>,
    messageIdOverride = messageId,
  ): Promise<ReturnType<typeof createFileCheckpointIfNeeded>> {
    const checkpoints = await createFileCheckpointIfNeeded(definition, params, ctx(messageIdOverride), tempDir);
    await afterExecute();
    for (const checkpoint of checkpoints) {
      await service.finalizeCheckpointDigest(checkpoint.checkpointId, checkpoint.filePath);
    }
    return checkpoints;
  }

  it('snapshots a declared MCP target inside the working directory and restores it on rewind', async () => {
    const file = path.join(tempDir, 'declared.md');
    await fs.writeFile(file, 'before-declared\n', 'utf-8');

    const checkpoints = await snapshotWriteFinalize(
      declaredMcpTool,
      { target: file, content: 'after-declared\n' },
      () => fs.writeFile(file, 'after-declared\n', 'utf-8'),
    );
    expect(checkpoints).toHaveLength(1);
    expect(checkpoints[0].filePath).toBe(await fs.realpath(file));
    expect(rows()).toEqual([
      { file_path: await fs.realpath(file), uncertain_target: 0, message_id: messageId },
    ]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([checkpoints[0].filePath]);
    expect(rewind.skippedFiles).toEqual([]);
    expect(await fs.readFile(file, 'utf-8')).toBe('before-declared\n');
  });

  it('deletes a declared-target file that did not exist before the MCP write', async () => {
    const file = path.join(tempDir, 'brand-new-declared.md');

    const checkpoints = await snapshotWriteFinalize(
      declaredMcpTool,
      { target: file, content: 'first\n' },
      () => fs.writeFile(file, 'first\n', 'utf-8'),
    );
    expect(checkpoints).toHaveLength(1);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.deletedFiles).toEqual([checkpoints[0].filePath]);
    await expect(fs.access(file)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('snapshots every entry of a declared parameter holding an array of targets', async () => {
    const first = path.join(tempDir, 'multi-a.md');
    const second = path.join(tempDir, 'multi-b.md');
    await fs.writeFile(first, 'a-before\n', 'utf-8');
    await fs.writeFile(second, 'b-before\n', 'utf-8');

    const checkpoints = await snapshotWriteFinalize(
      declaredMcpTool,
      { target: [first, second], content: 'after\n' },
      async () => {
        await fs.writeFile(first, 'after\n', 'utf-8');
        await fs.writeFile(second, 'after\n', 'utf-8');
      },
    );
    expect(checkpoints.map((entry) => path.basename(entry.filePath)).sort()).toEqual(['multi-a.md', 'multi-b.md']);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.map((filePath) => path.basename(filePath)).sort())
      .toEqual(['multi-a.md', 'multi-b.md']);
    expect(await fs.readFile(first, 'utf-8')).toBe('a-before\n');
    expect(await fs.readFile(second, 'utf-8')).toBe('b-before\n');
  });

  it('discloses a declared-but-empty target as uncertain:<param> instead of guessing', async () => {
    const checkpoints = await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: '  ', content: 'x' },
      ctx(),
      tempDir,
    );
    expect(checkpoints).toEqual([]);
    expect(rows()).toEqual([
      { file_path: 'uncertain:target', uncertain_target: 1, message_id: messageId },
    ]);
  });

  it('does not snapshot declared targets outside the working-directory boundary and discloses them', async () => {
    const outside = path.join(outsideDir, 'escape.md');
    await fs.writeFile(outside, 'outside-content\n', 'utf-8');
    const realOutside = await fs.realpath(outside);

    const checkpoints = await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: outside, content: 'hijack\n' },
      ctx(),
      tempDir,
    );
    await fs.writeFile(outside, 'hijack\n', 'utf-8');
    // 界外不建快照：server 不可信，快照会把任意路径的文件内容拷进本地 DB
    expect(checkpoints).toEqual([]);
    expect(rows()).toEqual([
      { file_path: realOutside, uncertain_target: 1, message_id: messageId },
    ]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles).toEqual([]);
    expect(rewind.skippedFiles).toEqual([{
      filePath: realOutside,
      reason: 'uncertain_write_target',
      detail: 'The write target could not be resolved or safely snapshotted when the tool ran, so no snapshot exists to restore.',
    }]);
    // 回退不碰界外文件：保持 MCP 写入后的内容
    expect(await fs.readFile(outside, 'utf-8')).toBe('hijack\n');
  });

  it('honours a workspace scope as the boundary: in-scope snapshots with attribution, out-of-scope discloses', async () => {
    const scope = createWorkspaceScope('project-1', [
      { sourceId: 'primary', path: tempDir, role: 'primary', access: 'read_write' },
    ]);
    const inside = path.join(tempDir, 'in-scope.md');
    await fs.writeFile(inside, 'in-before\n', 'utf-8');
    const outside = path.join(outsideDir, 'out-of-scope.md');
    await fs.writeFile(outside, 'out-before\n', 'utf-8');

    const insideCheckpoints = await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: inside, content: 'in-after\n' },
      () => ({ sessionId, messageId, workspaceScope: scope }),
      tempDir,
    );
    await fs.writeFile(inside, 'in-after\n', 'utf-8');
    for (const checkpoint of insideCheckpoints) {
      await service.finalizeCheckpointDigest(checkpoint.checkpointId, checkpoint.filePath);
    }
    expect(insideCheckpoints).toHaveLength(1);

    const outsideCheckpoints = await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: outside, content: 'out-after\n' },
      () => ({ sessionId, messageId: 'tool-call-2', workspaceScope: scope }),
      tempDir,
    );
    await fs.writeFile(outside, 'out-after\n', 'utf-8');
    expect(outsideCheckpoints).toEqual([]);

    // 界内快照带 Source 归属（与内置写工具同一条 attribution 管线）
    const insideRow = db.prepare(
      'SELECT source_id FROM file_checkpoints WHERE session_id = ? AND file_path = ?',
    ).get(sessionId, await fs.realpath(inside)) as { source_id: string | null };
    expect(insideRow.source_id).toBe('primary');

    const rewind = await service.rewindFiles(sessionId, messageId);
    expect(rewind.restoredFiles.map((filePath) => path.basename(filePath))).toEqual(['in-scope.md']);
    expect(rewind.skippedFiles.map((item) => path.basename(item.filePath))).toEqual(['out-of-scope.md']);
    expect(await fs.readFile(outside, 'utf-8')).toBe('out-after\n');
  });

  // ---- 未声明写盘：回退时逐工具披露，不静默（决策 b）----

  it('discloses an undeclared MCP write tool once on rewind without inferring its path parameter', async () => {
    const file = path.join(tempDir, 'inference-bait.txt');
    await fs.writeFile(file, 'before-bait\n', 'utf-8');

    const checkpoints = await createFileCheckpointIfNeeded(
      undeclaredMcpTool,
      { path: file, content: 'after-bait\n' },
      ctx(),
      tempDir,
    );
    await fs.writeFile(file, 'after-bait\n', 'utf-8');
    // 推断被否决：连 path 这种最像写目标的名字也不建快照、不落路径披露
    expect(checkpoints).toEqual([]);
    expect(rows()).toEqual([{
      file_path: 'undeclared-tool:mcp__fs__write_text_file',
      uncertain_target: 1,
      message_id: messageId,
    }]);

    const rewind = await service.rewindFiles(sessionId, messageId);
    // 每工具一条披露（不是每路径），success 不翻红（是披露不是恢复失败）
    expect(rewind.skippedFiles).toEqual([{
      filePath: 'undeclared-tool:mcp__fs__write_text_file',
      reason: 'undeclared_tool_write',
      toolName: 'mcp__fs__write_text_file',
      detail: "This tool's writes are not in the rollback scope.",
    }]);
    expect(rewind.success).toBe(true);
    expect(rewind.restoredFiles).toEqual([]);
    expect(await fs.readFile(file, 'utf-8')).toBe('after-bait\n');
  });

  it('keeps undeclared-tool disclosures per message so a later turn rewinds to its own disclosure', async () => {
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'a.txt') }, ctx('tool-call-1'), tempDir);
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'b.txt') }, ctx('tool-call-2'), tempDir);

    // 同一工具两轮各留一条（undeclared-tool: 键按 (session, key, message) 去重）
    expect(rows()).toEqual([
      { file_path: 'undeclared-tool:mcp__fs__write_text_file', uncertain_target: 1, message_id: 'tool-call-1' },
      { file_path: 'undeclared-tool:mcp__fs__write_text_file', uncertain_target: 1, message_id: 'tool-call-2' },
    ]);

    // 回退第二轮：窗口只含 tool-call-2 的行，该轮的未声明写盘照样披露
    const rewind = await service.rewindFiles(sessionId, 'tool-call-2');
    expect(rewind.skippedFiles).toEqual([{
      filePath: 'undeclared-tool:mcp__fs__write_text_file',
      reason: 'undeclared_tool_write',
      toolName: 'mcp__fs__write_text_file',
      detail: "This tool's writes are not in the rollback scope.",
    }]);
    expect(rewind.success).toBe(true);
  });

  it('collapses repeated undeclared calls in one turn into a single disclosure row', async () => {
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'a.txt') }, ctx(), tempDir);
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'b.txt') }, ctx(), tempDir);
    expect(rows()).toHaveLength(1);
  });

  // ---- Rework r1：undeclared-tool 逐轮行不得挤掉路径类披露（披露预算按类拆两池） ----

  it('keeps an earlier path disclosure when undeclared-tool rows flood their own budget', async () => {
    // ai-review Important 场景：先有一次 Bash 变量重定向写盘（路径类披露），之后多轮
    // 无 annotations 的 MCP 工具逐轮落 undeclared-tool 行——两池各自封顶，互不逐出。
    initFileCheckpointService({ maxCheckpointsPerSession: 3 });
    try {
      await createFileCheckpointIfNeeded(
        bashDefinition,
        { command: 'echo x > "$OUT"/a.txt' },
        ctx('tool-call-1'),
        tempDir,
      );
      for (let turn = 2; turn <= 5; turn++) {
        await createFileCheckpointIfNeeded(
          undeclaredMcpTool,
          { path: path.join(tempDir, `flood-${turn}.txt`) },
          ctx(`tool-call-${turn}`),
          tempDir,
        );
      }
      // undeclared 池自身仍封顶 3 条（最旧的 tool-call-2 被自己池内淘汰），路径披露原样存活
      expect(rows().map((row) => row.file_path)).toEqual([
        'uncertain-redirection:$OUT/a.txt',
        'undeclared-tool:mcp__fs__write_text_file',
        'undeclared-tool:mcp__fs__write_text_file',
        'undeclared-tool:mcp__fs__write_text_file',
      ]);

      // 回退轮次 1：路径披露照常出现在 skippedFiles，不是被挤掉后的无提示。注意
      // service 层的 success 本就因路径披露在场而为 false（「窗口内有未恢复项」的
      // 既有语义）——非致命口径在 sessionHistoryAppService，那里两种披露都不抛错。
      const rewind = await service.rewindFiles(sessionId, 'tool-call-1');
      expect(rewind.errors).toEqual([]);
      expect(rewind.skippedFiles.map((item) => item.reason).sort())
        .toEqual(['uncertain_write_target', 'undeclared_tool_write']);
      expect(rewind.skippedFiles.find((item) => item.reason === 'uncertain_write_target')?.filePath)
        .toBe('uncertain-redirection:$OUT/a.txt');
    } finally {
      initFileCheckpointService();
    }
  });

  it('keeps undeclared-tool rows when path disclosures flood their own budget', async () => {
    const limited = new FileCheckpointService({ maxCheckpointsPerSession: 3 });
    await limited.recordUncertainWriteTarget(sessionId, 'tool-call-1', 'undeclared-tool:mcp__fs__write_text_file');
    for (const key of ['$A', '$B', '$C', '$D']) {
      await limited.recordUncertainWriteTarget(sessionId, `msg-${key}`, `uncertain-redirection:${key}`);
    }
    // 反方向同样拆池：路径池自身封顶 3 条（$A 被自己池内淘汰），undeclared 行原样存活
    expect(rows().map((row) => row.file_path)).toEqual([
      'undeclared-tool:mcp__fs__write_text_file',
      'uncertain-redirection:$B',
      'uncertain-redirection:$C',
      'uncertain-redirection:$D',
    ]);
  });

  it('folds many turns of one undeclared tool into one rewind disclosure entry', async () => {
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'a.txt') }, ctx('tool-call-1'), tempDir);
    await createFileCheckpointIfNeeded(undeclaredMcpTool, { path: path.join(tempDir, 'b.txt') }, ctx('tool-call-2'), tempDir);

    const rewind = await service.rewindFiles(sessionId, 'tool-call-1');
    expect(rewind.skippedFiles).toHaveLength(1);
    expect(rewind.skippedFiles[0].toolName).toBe('mcp__fs__write_text_file');
  });

  it('keeps other uncertain keys deduped per (session, key) as before', async () => {
    await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: '  ', content: 'x' },
      ctx('tool-call-1'),
      tempDir,
    );
    await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: '', content: 'y' },
      ctx('tool-call-2'),
      tempDir,
    );
    // uncertain:<param> 维持旧行为：同一 session 同键只留最早一条（不按消息翻倍）
    expect(rows()).toEqual([
      { file_path: 'uncertain:target', uncertain_target: 1, message_id: 'tool-call-1' },
    ]);
  });

  // ---- 回归：已覆盖/只读工具不产生 undeclared 噪音 ----

  it('records no undeclared row for a readOnly MCP tool or covered built-ins', async () => {
    // readOnlyHint + openWorldHint 的 MCP 工具：network 档但只读
    await createFileCheckpointIfNeeded(readOnlyMcpTool, { query: 'x' }, ctx(), tempDir);
    // Bash / Write 走声明（pathAuthority / 六名下限），不在未声明集合里
    await createFileCheckpointIfNeeded(bashDefinition, { command: 'ls -la' }, ctx(), tempDir);
    await createFileCheckpointIfNeeded(
      writeDefinition,
      { file_path: path.join(tempDir, 'w.md'), content: 'w\n' },
      ctx(),
      tempDir,
    );
    expect(rows().filter((row) => row.file_path.startsWith('undeclared-tool:'))).toEqual([]);
  });

  it('records no undeclared row for a declared MCP tool that produced snapshots', async () => {
    const file = path.join(tempDir, 'covered.md');
    await fs.writeFile(file, 'covered\n', 'utf-8');
    await createFileCheckpointIfNeeded(
      declaredMcpTool,
      { target: file, content: 'x' },
      ctx(),
      tempDir,
    );
    expect(rows().filter((row) => row.file_path.startsWith('undeclared-tool:'))).toEqual([]);
    expect(rows()).toHaveLength(1);
  });
});
