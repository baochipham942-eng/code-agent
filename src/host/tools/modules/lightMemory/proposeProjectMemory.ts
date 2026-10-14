// ============================================================================
// ProposeProjectMemory — /init-memory 的候选写入工具
//
// 项目目录 = 本次 run 的 workingDir。id = initmem_ + hash(resolve(workingDir) + topic)，
// 与旧扫描器同一条 id 方案。status 恒为 candidate；同键（任何 status）只返回已有正文，
// 不覆盖。落盘复用 writeEntryToLightMemory + rebuildMemoryMirrorFromLightFiles。
// ============================================================================

import * as fs from 'fs/promises';
import path from 'node:path';
import type { MemoryEntry, MemoryEntryEvidence, ProjectMemoryDraftTopic } from '../../../../shared/contract/memory';
import type {
  CanUseToolFn,
  ToolContext,
  ToolHandler,
  ToolModule,
  ToolResult,
  ToolSchema,
} from '../../../protocol/tools';
import { contentHash } from '../../../memory/importers/markdown';
import {
  listUnifiedMemoryEntries,
  rebuildMemoryMirrorFromLightFiles,
  writeEntryToLightMemory,
  type MemoryEntryDatabase,
} from '../../../memory/memoryEntryRuntime';
import { getDatabase } from '../../../services/core/databaseService';
import { proposeProjectMemorySchema } from './proposeProjectMemory.schema';

const schema: ToolSchema = proposeProjectMemorySchema;

const TOPIC_TITLES: Record<ProjectMemoryDraftTopic, string> = {
  purpose: '项目用途（init-memory 草稿）',
  'key-files': '关键文件（init-memory 草稿）',
  conventions: '使用约定（init-memory 草稿）',
};

function isTopic(value: unknown): value is ProjectMemoryDraftTopic {
  return value === 'purpose' || value === 'key-files' || value === 'conventions';
}

function draftEntryId(projectDir: string, topic: ProjectMemoryDraftTopic): string {
  return `initmem_${contentHash(`${projectDir}\n${topic}`)}`;
}

/** path.relative 对目录内的 `..hidden` 也会以 `..` 开头，不能用 startsWith('..')。 */
function escapesRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

async function resolveSource(projectDir: string, source: unknown): Promise<string | null> {
  if (typeof source !== 'string' || source.trim() === '') return null;
  const lexical = path.resolve(projectDir, source.trim());
  if (escapesRoot(projectDir, lexical)) return null;
  let realRoot: string;
  try {
    realRoot = await fs.realpath(projectDir);
  } catch {
    return null;
  }
  try {
    const realTarget = await fs.realpath(lexical);
    if (escapesRoot(realRoot, realTarget)) return null;
  } catch {
    // 文件可以尚未落盘；词法路径已经在目录内就收下这条引用。
  }
  const relative = path.relative(projectDir, lexical);
  return relative === '' ? '.' : relative;
}

function candidateEntry(
  projectDir: string,
  topic: ProjectMemoryDraftTopic,
  summary: string,
  content: string,
  sources: string[],
  now: number,
): MemoryEntry {
  const id = draftEntryId(projectDir, topic);
  const hash = id.slice('initmem_'.length);
  const evidence: MemoryEntryEvidence[] = sources.map((source) => ({
    filePath: source,
    source: 'init-memory',
  }));
  return {
    id,
    schemaVersion: 2,
    status: 'candidate',
    deprecatedBy: null,
    kind: 'project',
    scope: 'project',
    title: TOPIC_TITLES[topic],
    summary,
    content,
    source: {
      kind: 'import',
      sourceOfTruth: 'light_file',
      filePath: `initmem-${hash}.md`,
      label: `init-memory: ${projectDir}`,
    },
    evidence,
    projectPath: projectDir,
    sessionId: null,
    confidence: 0.7,
    createdAt: now,
    updatedAt: now,
  };
}

function formatExists(topic: ProjectMemoryDraftTopic, entry: MemoryEntry): string {
  return [
    'exists, not overwritten',
    `topic: ${topic}`,
    `id: ${entry.id}`,
    `status: ${entry.status}`,
    'content:',
    entry.content,
  ].join('\n');
}

function formatWritten(topic: ProjectMemoryDraftTopic, entry: MemoryEntry): string {
  return [
    'Wrote a candidate project memory. status: candidate. It does not take effect until confirmed in Settings -> Memory.',
    `topic: ${topic}`,
    `id: ${entry.id}`,
    'content:',
    entry.content,
  ].join('\n');
}

/**
 * CLI 刻意不初始化宿主 DatabaseService（见 cli bootstrap）。
 * 确认列表在数据库不可用时回退到轻量文件，所以这里探测失败就只写文件、不建镜像。
 * 宿主库已初始化时仍重建镜像，和桌面路径一致。
 */
function usableMemoryDatabase(): MemoryEntryDatabase | undefined {
  const db = getDatabase();
  try {
    db.listMemories({ limit: 1 });
    return db;
  } catch (error) {
    if (error instanceof Error && error.message === 'Database not initialized') return undefined;
    throw error;
  }
}

async function propose(
  db: MemoryEntryDatabase | undefined,
  projectDir: string,
  topic: ProjectMemoryDraftTopic,
  summary: string,
  content: string,
  sources: string[],
  now: number,
): Promise<ToolResult<string>> {
  const id = draftEntryId(projectDir, topic);
  const existing = (await listUnifiedMemoryEntries(db)).entries.find((entry) => entry.id === id);
  if (existing) {
    return {
      ok: true,
      output: formatExists(topic, existing),
      meta: { outcome: 'exists', id, topic, status: existing.status },
    };
  }
  const entry = candidateEntry(projectDir, topic, summary, content, sources, now);
  await writeEntryToLightMemory(entry);
  if (db) await rebuildMemoryMirrorFromLightFiles(db);
  return {
    ok: true,
    output: formatWritten(topic, entry),
    meta: { outcome: 'written', id, topic, status: 'candidate' },
  };
}

class ProposeProjectMemoryHandler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    canUseTool: CanUseToolFn,
  ): Promise<ToolResult<string>> {
    if (!isTopic(args.topic)) {
      return {
        ok: false,
        error: 'topic must be purpose, key-files, or conventions',
        code: 'INVALID_ARGS',
      };
    }
    const summary = typeof args.summary === 'string' ? args.summary.replace(/\s+/g, ' ').trim() : '';
    if (!summary) {
      return { ok: false, error: 'summary is required', code: 'INVALID_ARGS' };
    }
    const content = typeof args.content === 'string' ? args.content.trim() : '';
    if (!content) {
      return { ok: false, error: 'content is required', code: 'INVALID_ARGS' };
    }
    if (!Array.isArray(args.sources) || args.sources.length === 0) {
      return {
        ok: false,
        error: 'sources must list at least one path inside the working folder',
        code: 'INVALID_ARGS',
      };
    }
    const projectDir = typeof ctx.workingDir === 'string' ? path.resolve(ctx.workingDir) : '';
    if (!projectDir) {
      return { ok: false, error: 'working directory is required', code: 'INVALID_ARGS' };
    }

    const sources: string[] = [];
    for (const source of args.sources) {
      const relative = await resolveSource(projectDir, source);
      if (relative === null) {
        return {
          ok: false,
          error: `source is outside the working folder: ${String(source)}`,
          code: 'INVALID_ARGS',
        };
      }
      if (!sources.includes(relative)) sources.push(relative);
    }

    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) {
      return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    }
    if (ctx.abortSignal.aborted) {
      return { ok: false, error: 'aborted', code: 'ABORTED' };
    }

    try {
      const result = await propose(
        usableMemoryDatabase(),
        projectDir,
        args.topic,
        summary,
        content,
        sources,
        Date.now(),
      );
      if (result.ok) {
        ctx.logger.info('ProposeProjectMemory done', {
          topic: args.topic,
          id: result.meta?.id,
          outcome: result.meta?.outcome,
        });
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      return { ok: false, error: `Failed to save project memory draft: ${message}`, code: 'FS_ERROR' };
    }
  }
}

export const proposeProjectMemoryModule: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler: () => new ProposeProjectMemoryHandler(),
};
