// ============================================================================
// SkillDraftQueue — skill 蒸馏半自动确认队列（GAP-005）
// learningPipeline 从 telemetry 提取的重复成功模式生成 SKILL.md 草稿，
// 落到 ~/.code-agent/skill-drafts/（与 skills/ 平级，不会被 discovery 扫描）。
// 严禁自动入库：只有用户通过 IPC 确认后才移入 skills 目录。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir, getSkillsDir } from '../../config/configPaths';
import { LEARNING_PIPELINE } from '../../../shared/constants';
import type { SkillDraftOrigin } from '../../../shared/contract/agent';
import { scanSkillContent } from '../../security/skillContentGuard';
import { createLogger } from '../infra/logger';

export type { SkillDraftOrigin };

const logger = createLogger('SkillDraftQueue');

const DRAFT_META_FILENAME = 'draft.json';
const REJECTED_LEDGER_FILENAME = 'rejected.json';
const ACCEPTED_LEDGER_FILENAME = 'accepted.json';

export interface SkillDraftMeta {
  /** 草稿目录名（队列内唯一） */
  id: string;
  /** 建议的 skill 名 */
  name: string;
  description: string;
  /** 模式去重 key（同一模式不重复入队，被拒绝过的不再入队） */
  patternKey: string;
  /** 模式对应的工具序列（LLM 复盘草稿可为空数组） */
  toolSequence: string[];
  /** 模式在来源 session 中出现的次数（LLM 复盘草稿为 0） */
  occurrences: number;
  /** 草稿来源（缺省视为 telemetry-distilled，兼容旧草稿） */
  origin: SkillDraftOrigin;
  sessionId: string;
  createdAt: number;
  status: 'pending';
}

export interface SkillDraftStep {
  toolName: string;
  args: Record<string, unknown>;
}

export function getSkillDraftsDir(): string {
  return path.join(getUserConfigDir(), LEARNING_PIPELINE.DRAFTS_DIR_NAME);
}

function getRejectedLedgerPath(): string {
  return path.join(getSkillDraftsDir(), REJECTED_LEDGER_FILENAME);
}

function getAcceptedLedgerPath(): string {
  return path.join(getSkillDraftsDir(), ACCEPTED_LEDGER_FILENAME);
}

// ----------------------------------------------------------------------------
// 草稿生成
// ----------------------------------------------------------------------------

function sanitizeDraftId(name: string, timestamp: number): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `${safe || 'workflow'}-${timestamp}`;
}

function truncateArgValue(value: unknown): unknown {
  if (typeof value === 'string' && value.length > 200) {
    return `${value.substring(0, 200)}...`;
  }
  return value;
}

/** 生成草稿 SKILL.md 内容（模板风格对齐 comboRecorder.generateSkillMd）。
 * 两种来源走两套正文：
 *   - body 提供（LLM 复盘）：直接采用模型提炼的语义正文
 *   - 否则（telemetry 蒸馏）：从工具序列机械还原步骤
 */
export function generateDraftSkillMd(input: {
  name: string;
  description: string;
  sessionId: string;
  createdAt: number;
  origin?: SkillDraftOrigin;
  toolSequence?: string[];
  occurrences?: number;
  exampleSteps?: SkillDraftStep[];
  body?: string;
}): string {
  const origin: SkillDraftOrigin = input.origin ?? 'telemetry-distilled';
  const fm: string[] = [
    '---',
    `name: ${input.name}`,
    `description: "${input.description.replace(/"/g, "'")}"`,
    'user-invocable: true',
  ];
  // 只有 telemetry 草稿带可执行工具序列才声明 allowed-tools
  if (input.toolSequence && input.toolSequence.length > 0) {
    fm.push(`allowed-tools: "${input.toolSequence.join(',')}"`);
  }
  fm.push('context: inline');
  fm.push('metadata:');
  fm.push(`  source: ${origin}`);
  fm.push(`  distilled-at: "${new Date(input.createdAt).toISOString().split('T')[0]}"`);
  fm.push(`  session: "${input.sessionId}"`);
  if (input.occurrences && input.occurrences > 0) {
    fm.push(`  occurrences: "${input.occurrences}"`);
  }
  fm.push('---');
  const frontmatter = fm.join('\n');

  // LLM 复盘草稿：正文 = 模型提炼的可复用指南
  if (input.body && input.body.trim()) {
    const body = ['', `# ${input.name}`, '', `> ${input.description}`, '', input.body.trim(), ''].join('\n');
    return `${frontmatter}\n${body}\n`;
  }

  // telemetry 蒸馏草稿：从工具序列机械还原
  const steps = input.exampleSteps ?? [];
  const body: string[] = [
    '',
    `# ${input.name}`,
    '',
    `> ${input.description}`,
    '',
    `本工作流在历史会话中成功重复了 ${input.occurrences ?? 0} 次，由经验沉淀管线自动蒸馏。`,
    '',
    '## 工作流步骤',
    '',
  ];

  steps.forEach((step, idx) => {
    body.push(`${idx + 1}. \`${step.toolName}\``);
    const argEntries = Object.entries(step.args);
    if (argEntries.length > 0) {
      const preview = argEntries
        .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
        .join(', ');
      body.push(`   - 示例参数: ${preview}`);
    }
  });

  body.push('');
  body.push('## 执行指南');
  body.push('');
  body.push('按照上述步骤顺序执行，根据当前任务调整参数。如果某一步失败，先分析原因再重试。');

  return `${frontmatter}\n${body.join('\n')}\n`;
}

// ----------------------------------------------------------------------------
// 队列操作
// ----------------------------------------------------------------------------

async function loadRejectedKeys(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(getRejectedLedgerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

async function saveRejectedKeys(keys: Set<string>): Promise<void> {
  await fs.mkdir(getSkillDraftsDir(), { recursive: true });
  await fs.writeFile(getRejectedLedgerPath(), JSON.stringify(Array.from(keys), null, 2), 'utf-8');
}

// accepted ledger：草稿确认入库后记账，避免同一 pattern 跨会话反复蒸馏打扰用户
async function loadAcceptedKeys(): Promise<Set<string>> {
  try {
    const raw = await fs.readFile(getAcceptedLedgerPath(), 'utf-8');
    const parsed = JSON.parse(raw) as string[];
    return new Set(Array.isArray(parsed) ? parsed : []);
  } catch {
    return new Set();
  }
}

async function recordAcceptedKey(patternKey: string): Promise<void> {
  if (!patternKey) return;
  const accepted = await loadAcceptedKeys();
  if (accepted.has(patternKey)) return;
  accepted.add(patternKey);
  await fs.mkdir(getSkillDraftsDir(), { recursive: true });
  await fs.writeFile(getAcceptedLedgerPath(), JSON.stringify(Array.from(accepted), null, 2), 'utf-8');
}

/**
 * 列出待确认的草稿。
 */
export async function listSkillDrafts(): Promise<SkillDraftMeta[]> {
  const dir = getSkillDraftsDir();
  const drafts: SkillDraftMeta[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }

  for (const entry of entries) {
    const metaPath = path.join(dir, entry, DRAFT_META_FILENAME);
    try {
      const raw = await fs.readFile(metaPath, 'utf-8');
      drafts.push(JSON.parse(raw) as SkillDraftMeta);
    } catch {
      // 不是草稿目录（如 rejected.json），跳过
    }
  }

  return drafts.sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * 把成功模式入队为草稿。同一 patternKey 已在队列中或已被拒绝过则跳过（返回 null）。
 */
export async function enqueueSkillDraft(input: {
  name: string;
  description: string;
  patternKey: string;
  sessionId: string;
  /** 草稿来源，缺省 telemetry-distilled（兼容旧调用） */
  origin?: SkillDraftOrigin;
  /** telemetry 蒸馏路径用：成功工具序列 */
  toolSequence?: string[];
  occurrences?: number;
  exampleSteps?: SkillDraftStep[];
  /** LLM 复盘路径用：直接采用的 skill 正文（Markdown） */
  body?: string;
  timestamp?: number;
}): Promise<SkillDraftMeta | null> {
  const createdAt = input.timestamp ?? Date.now();
  const origin: SkillDraftOrigin = input.origin ?? 'telemetry-distilled';

  const [existing, rejected, accepted] = await Promise.all([
    listSkillDrafts(),
    loadRejectedKeys(),
    loadAcceptedKeys(),
  ]);
  if (rejected.has(input.patternKey)) {
    logger.debug('Skill draft skipped (previously rejected)', { patternKey: input.patternKey });
    return null;
  }
  if (accepted.has(input.patternKey)) {
    logger.debug('Skill draft skipped (already accepted/installed)', { patternKey: input.patternKey });
    return null;
  }
  if (existing.some((draft) => draft.patternKey === input.patternKey)) {
    logger.debug('Skill draft skipped (already pending)', { patternKey: input.patternKey });
    return null;
  }

  const id = sanitizeDraftId(input.name, createdAt);
  const draftDir = path.join(getSkillDraftsDir(), id);
  await fs.mkdir(draftDir, { recursive: true });

  const meta: SkillDraftMeta = {
    id,
    name: input.name,
    description: input.description,
    patternKey: input.patternKey,
    toolSequence: input.toolSequence ?? [],
    occurrences: input.occurrences ?? 0,
    origin,
    sessionId: input.sessionId,
    createdAt,
    status: 'pending',
  };

  const skillMd = generateDraftSkillMd({
    name: input.name,
    description: input.description,
    origin,
    sessionId: input.sessionId,
    toolSequence: input.toolSequence,
    occurrences: input.occurrences,
    exampleSteps: (input.exampleSteps ?? []).map((step) => ({
      toolName: step.toolName,
      args: Object.fromEntries(
        Object.entries(step.args).map(([key, value]) => [key, truncateArgValue(value)]),
      ),
    })),
    body: input.body,
    createdAt,
  });

  await fs.writeFile(path.join(draftDir, 'SKILL.md'), skillMd, 'utf-8');
  await fs.writeFile(path.join(draftDir, DRAFT_META_FILENAME), JSON.stringify(meta, null, 2), 'utf-8');

  logger.info('Skill draft enqueued (pending user confirmation)', { id, name: input.name });
  return meta;
}

/**
 * 用户确认草稿：把 SKILL.md 移入用户 skills 目录并刷新 discovery。
 */
export async function confirmSkillDraft(
  id: string,
  workingDirectory?: string,
): Promise<{ success: boolean; skillPath?: string; error?: string }> {
  const draftDir = path.join(getSkillDraftsDir(), path.basename(id));
  const metaPath = path.join(draftDir, DRAFT_META_FILENAME);

  let meta: SkillDraftMeta;
  try {
    meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SkillDraftMeta;
  } catch {
    return { success: false, error: `Draft not found: ${id}` };
  }

  try {
    const skillContent = await fs.readFile(path.join(draftDir, 'SKILL.md'), 'utf-8');

    // fail-closed 安全闸：草稿入库前过内容扫描，命中 critical 危险命令 / 明文密钥则拒绝。
    // 反超 Hermes（其 agent-created skill 默认不扫描）；草稿留在队列，用户可查看后删除。
    const guard = scanSkillContent(skillContent);
    if (guard.verdict === 'block') {
      logger.warn('Skill draft blocked by content guard', {
        id,
        findings: guard.findings.map((f) => f.kind),
      });
      return {
        success: false,
        error: `安全扫描未通过，已拒绝入库：${guard.findings.map((f) => f.detail).join('；')}`,
      };
    }

    const skillsDir = getSkillsDir(workingDirectory);
    const targetDir = path.join(skillsDir.user.new, meta.name);
    await fs.mkdir(targetDir, { recursive: true });

    const skillPath = path.join(targetDir, 'SKILL.md');
    await fs.writeFile(skillPath, skillContent, 'utf-8');
    await fs.rm(draftDir, { recursive: true, force: true });
    // 记入 accepted ledger：同一 pattern 已采纳后不再跨会话重复蒸馏打扰
    await recordAcceptedKey(meta.patternKey);

    logger.info('Skill draft confirmed and installed', { id, name: meta.name, skillPath });
    return { success: true, skillPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to confirm skill draft', { id, error: message });
    return { success: false, error: message };
  }
}

/**
 * 用户拒绝草稿：删除草稿并记入 rejected ledger（同一模式不再重复打扰）。
 */
export async function rejectSkillDraft(id: string): Promise<{ success: boolean; error?: string }> {
  const draftDir = path.join(getSkillDraftsDir(), path.basename(id));
  const metaPath = path.join(draftDir, DRAFT_META_FILENAME);

  let patternKey: string;
  try {
    const meta = JSON.parse(await fs.readFile(metaPath, 'utf-8')) as SkillDraftMeta;
    patternKey = meta.patternKey;
  } catch {
    return { success: false, error: `Draft not found: ${id}` };
  }

  try {
    await fs.rm(draftDir, { recursive: true, force: true });
    if (patternKey) {
      const rejected = await loadRejectedKeys();
      rejected.add(patternKey);
      await saveRejectedKeys(rejected);
    }
    logger.info('Skill draft rejected', { id, patternKey });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
