// ============================================================================
// Role Write-Back — 实例结束时的记忆写回（设计 §5 步骤 3）
// ============================================================================
//
// 流程：
//   1. 模型自判断：quick model 看任务 + 执行过程 → 候选记忆（含层路由）+ 履历摘要
//   2. write gate：配额（≤3 条）+ 质量门槛（拒流水账）+ 去重（同名更新而非新建）
//   3. 落盘：按层写入（role/project 走 roleAssetService，global 走现有 Light Memory）
//   4. 履历：追加产物清单条目
//
// 质量保障（设计 §11）：
//   - 写回用 quick model，成本可忽略；失败静默降级（只记履历，不写记忆）
//   - 多实例并发写回同一角色 → 串行队列（MVP 阶段）
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { quickTask } from '../../model/quickModel';
import { withTimeout } from '../infra/timeoutController';
import { createLogger } from '../infra/logger';
import { ROLE_ASSETS } from '../../../shared/constants';
import { ensureMemoryDir, getMemoryIndexPath } from '../../lightMemory/indexLoader';
import {
  appendRoleHistory,
  isPersistentRole,
  listScopedMemories,
  writeScopedMemory,
  type RoleMemoryEntry,
} from './roleAssetService';

const logger = createLogger('RoleWriteBack');

// ----------------------------------------------------------------------------
// 类型
// ----------------------------------------------------------------------------

export type MemoryLayer = 'global' | 'role' | 'project';

export interface WriteBackInput {
  /** 角色 ID（agent 注册 id） */
  roleId: string;
  /** 工作目录（项目记忆 key）；缺省则候选项目记忆降级为角色记忆 */
  workspacePath?: string;
  /** 实例的任务 prompt */
  taskPrompt: string;
  /** 实例的最终输出 */
  finalOutput: string;
  /** 实例产出的产物（履历用） */
  artifacts?: Array<{ label: string; ref?: string }>;
}

export interface WriteBackCandidate extends RoleMemoryEntry {
  layer: MemoryLayer;
}

export interface WriteBackResult {
  /** 是否执行了写回（非持久角色 / 判断失败时为 false） */
  executed: boolean;
  /** 实际写入的记忆条数 */
  written: number;
  /** 被 write gate 拒绝的条数 */
  rejected: number;
  /** 履历是否已追加 */
  historyAppended: boolean;
}

// ----------------------------------------------------------------------------
// 串行写回队列（设计 §11：MVP 阶段串行写回，避免并发冲突）
// ----------------------------------------------------------------------------

const writeBackQueues = new Map<string, Promise<unknown>>();

function enqueueWriteBack<T>(roleId: string, job: () => Promise<T>): Promise<T> {
  const prev = writeBackQueues.get(roleId) ?? Promise.resolve();
  const next = prev.then(job, job);
  writeBackQueues.set(roleId, next.catch(() => {}));
  return next;
}

// ----------------------------------------------------------------------------
// 写回入口
// ----------------------------------------------------------------------------

/**
 * 执行一次实例写回。非持久角色直接跳过（零成本）。
 * 设计上是 fire-and-forget 调用：失败只记日志，绝不影响实例返回。
 */
export async function runRoleWriteBack(input: WriteBackInput): Promise<WriteBackResult> {
  const skipped: WriteBackResult = { executed: false, written: 0, rejected: 0, historyAppended: false };

  if (!(await isPersistentRole(input.roleId))) {
    return skipped;
  }

  return enqueueWriteBack(input.roleId, async () => {
    try {
      return await doWriteBack(input);
    } catch (err) {
      logger.warn('Role write-back failed (non-blocking)', { roleId: input.roleId, error: String(err) });
      return skipped;
    }
  });
}

async function doWriteBack(input: WriteBackInput): Promise<WriteBackResult> {
  // 1. 模型自判断（quick model）
  const judgment = await judgeWriteBack(input);

  // 2. write gate
  const existingRole = await listScopedMemories({ scope: 'role', roleId: input.roleId });
  const existingFilenames = new Set(existingRole.map((m) => m.filename));
  const { accepted, rejected } = applyWriteGate(judgment?.candidates ?? [], existingFilenames);

  // 3. 按层落盘
  let written = 0;
  for (const candidate of accepted) {
    try {
      await writeCandidate(candidate, input);
      written++;
    } catch (err) {
      logger.warn('Failed to write memory candidate', { filename: candidate.filename, error: String(err) });
    }
  }

  // 4. 履历（产物清单）—— 即使没有记忆值得写，工作过就要记履历
  let historyAppended = false;
  try {
    const date = new Date().toISOString().slice(0, 10);
    const summary = judgment?.historySummary || truncate(input.taskPrompt.replace(/\s+/g, ' '), 60);
    const primaryArtifact = input.artifacts?.[0];
    await appendRoleHistory(input.roleId, {
      date,
      artifactLabel: primaryArtifact?.label || summary,
      artifactRef: primaryArtifact?.ref || '-',
      summary: primaryArtifact ? summary : '（无产物落盘）',
    });
    historyAppended = true;
  } catch (err) {
    logger.warn('Failed to append role history', { roleId: input.roleId, error: String(err) });
  }

  logger.info('Role write-back completed', {
    roleId: input.roleId,
    written,
    rejected: rejected.length,
    historyAppended,
  });

  return { executed: true, written, rejected: rejected.length, historyAppended };
}

// ----------------------------------------------------------------------------
// 1. 模型自判断（quick model，设计 §3.2 路由规则）
// ----------------------------------------------------------------------------

interface WriteBackJudgment {
  candidates: WriteBackCandidate[];
  historySummary: string;
}

function buildJudgePrompt(input: WriteBackInput, existingIndex: string): string {
  const transcript = [
    `任务：${truncate(input.taskPrompt, 2000)}`,
    `最终输出：${truncate(input.finalOutput, ROLE_ASSETS.WRITE_BACK_TRANSCRIPT_MAX_CHARS)}`,
  ].join('\n\n');

  return `你是角色记忆写回判断器。持久化角色"${input.roleId}"刚完成一次任务，请判断有哪些"下次还有用"的知识值得写入它的长期记忆。

只返回一个 JSON 对象，不要任何额外文字、不要 markdown 代码块：
{
  "memories": [
    {
      "layer": "role" 或 "project" 或 "global",
      "filename": "kebab-case-slug.md",
      "name": "记忆名",
      "description": "一句话描述，用于索引检索",
      "content": "记忆正文（markdown）"
    }
  ],
  "historySummary": "本次工作产出的一句话总结（不超过60字）"
}

判断规则：
- 最多 ${ROLE_ASSETS.WRITE_BACK_MAX_ENTRIES} 条，没有值得记的就返回空数组 []。宁缺毋滥。
- 拒绝流水账："完成了某任务"不是记忆（履历会单独记录）。只收下次执行同类任务还有用的知识：业务口径、用户偏好、踩过的坑、有效的方法。
- layer 路由：
  - 这个角色的专业积累，换个项目还有用 → "role"
  - 只在当前项目/工作目录有意义 → "project"
  - 和角色无关、和项目无关的用户级事实 → "global"
  - 不确定时选更窄的层（project 优先于 role，role 优先于 global）
- 该角色已有的记忆索引如下，相关的内容用相同 filename 更新（合并新旧信息），不要新建重复条目：
${existingIndex || '（暂无）'}

${transcript}`;
}

async function judgeWriteBack(input: WriteBackInput): Promise<WriteBackJudgment | null> {
  const existingRole = await listScopedMemories({ scope: 'role', roleId: input.roleId });
  const existingIndex = existingRole.map((m) => `- [${m.filename}] ${m.description}`).join('\n');

  try {
    const result = await withTimeout(
      quickTask(buildJudgePrompt(input, existingIndex), ROLE_ASSETS.WRITE_BACK_MAX_TOKENS),
      ROLE_ASSETS.WRITE_BACK_TIMEOUT_MS,
      'Role write-back judgment timed out',
    );
    if (!result.success || !result.content) {
      logger.warn('Quick model unavailable for write-back judgment', { error: result.error });
      return null;
    }
    return parseJudgment(result.content);
  } catch (err) {
    logger.warn('Write-back judgment failed', { error: String(err) });
    return null;
  }
}

function parseJudgment(raw: string): WriteBackJudgment | null {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const obj = parsed as Record<string, unknown>;
  const candidates: WriteBackCandidate[] = [];

  if (Array.isArray(obj.memories)) {
    for (const item of obj.memories) {
      if (typeof item !== 'object' || item === null) continue;
      const m = item as Record<string, unknown>;
      const layer = m.layer === 'global' || m.layer === 'project' ? m.layer : 'role';
      const filename = typeof m.filename === 'string' ? m.filename.trim() : '';
      const name = typeof m.name === 'string' ? m.name.trim() : '';
      const description = typeof m.description === 'string' ? m.description.trim() : '';
      const content = typeof m.content === 'string' ? m.content.trim() : '';
      if (!filename || !name || !description || !content) continue;
      candidates.push({
        layer,
        filename: filename.endsWith('.md') ? filename : `${filename}.md`,
        name,
        description,
        content,
      });
    }
  }

  return {
    candidates,
    historySummary: typeof obj.historySummary === 'string' ? obj.historySummary.trim() : '',
  };
}

// ----------------------------------------------------------------------------
// 2. Write Gate（设计 §5.1：去重 + 质量门槛 + 配额）
// ----------------------------------------------------------------------------

/** 流水账模式：纯"做了什么"的描述，没有可复用的知识 */
const LOG_LIKE_PATTERNS = [
  /^(成功|已经?)?(完成|执行|处理)了?.{0,20}(任务|工作|请求)/,
  /^(本次|这次)(任务|工作|会话)/,
];

export function applyWriteGate(
  candidates: WriteBackCandidate[],
  existingFilenames: Set<string>,
): { accepted: WriteBackCandidate[]; rejected: WriteBackCandidate[] } {
  const accepted: WriteBackCandidate[] = [];
  const rejected: WriteBackCandidate[] = [];
  const seenInBatch = new Set<string>();

  for (const candidate of candidates) {
    // 配额闸（设计 §5.1 #3）
    if (accepted.length >= ROLE_ASSETS.WRITE_BACK_MAX_ENTRIES) {
      rejected.push(candidate);
      continue;
    }
    // 质量闸（设计 §5.1 #2）：拒流水账、拒超长、拒过短
    const isLogLike = LOG_LIKE_PATTERNS.some((p) => p.test(candidate.content)) &&
      candidate.content.length < 100;
    if (isLogLike || candidate.content.length < 10) {
      rejected.push(candidate);
      continue;
    }
    if (candidate.content.length > ROLE_ASSETS.WRITE_BACK_CONTENT_MAX_CHARS) {
      candidate.content = candidate.content.slice(0, ROLE_ASSETS.WRITE_BACK_CONTENT_MAX_CHARS) + '\n\n<!-- truncated by write gate -->';
    }
    // 批内去重闸（设计 §5.1 #1）：同名只取第一条；与现有记忆同名 = 更新（放行）
    if (seenInBatch.has(candidate.filename)) {
      rejected.push(candidate);
      continue;
    }
    seenInBatch.add(candidate.filename);
    accepted.push(candidate);
  }

  // existingFilenames 用于观测日志（同名 = 更新而非新建）
  const updates = accepted.filter((c) => existingFilenames.has(c.filename)).length;
  if (updates > 0) {
    logger.info('Write gate: candidates updating existing memories', { updates });
  }

  return { accepted, rejected };
}

// ----------------------------------------------------------------------------
// 3. 按层落盘
// ----------------------------------------------------------------------------

async function writeCandidate(candidate: WriteBackCandidate, input: WriteBackInput): Promise<void> {
  const entry: RoleMemoryEntry = {
    filename: candidate.filename,
    name: candidate.name,
    description: candidate.description,
    content: candidate.content,
  };

  if (candidate.layer === 'project') {
    if (input.workspacePath) {
      await writeScopedMemory({ scope: 'project', workspacePath: input.workspacePath }, entry);
      return;
    }
    // 没有 workspace 时降级到角色层（路由规则：不确定降级到更窄的层不可行时取相邻层）
    await writeScopedMemory({ scope: 'role', roleId: input.roleId }, entry);
    return;
  }

  if (candidate.layer === 'role') {
    await writeScopedMemory({ scope: 'role', roleId: input.roleId }, entry);
    return;
  }

  // global 层：写入现有 Light Memory（~/.code-agent/memory/ + INDEX.md）
  await writeGlobalMemory(entry);
}

/** 全局层写入：复用 Light Memory 的文件格式和 INDEX.md 维护逻辑 */
async function writeGlobalMemory(entry: RoleMemoryEntry): Promise<void> {
  const memDir = await ensureMemoryDir();
  const filename = path.basename(entry.filename);
  const fileContent = `---
name: ${entry.name}
description: ${entry.description}
type: reference
---

${entry.content}
`;
  await fs.writeFile(path.join(memDir, filename), fileContent, 'utf-8');

  // INDEX.md 维护（与 memoryWrite.ts updateIndex 同一格式）
  const indexPath = getMemoryIndexPath();
  let lines: string[] = [];
  try {
    lines = (await fs.readFile(indexPath, 'utf-8')).split('\n');
  } catch {
    lines = ['# Memory Index', ''];
  }
  const escaped = filename.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const entryPattern = new RegExp(`^- \\[${escaped}\\]`);
  lines = lines.filter((line) => !entryPattern.test(line));
  lines.push(`- [${filename}](${filename}) — ${entry.description}`);
  await fs.writeFile(indexPath, lines.join('\n'), 'utf-8');
}

// ----------------------------------------------------------------------------
// helpers
// ----------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? trimmed.slice(0, max).trim() + '...' : trimmed;
}
