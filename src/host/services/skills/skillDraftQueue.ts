// ============================================================================
// SkillDraftQueue — skill 蒸馏半自动确认队列（GAP-005）
// learningPipeline 从 telemetry 提取的重复成功模式生成 SKILL.md 草稿，
// 落到 ~/.code-agent/skill-drafts/（与 skills/ 平级，不会被 discovery 扫描）。
// 严禁自动入库：只有用户通过 IPC 确认后才移入 skills 目录。
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserConfigDir, getSkillsDir } from '../../config/configPaths';
import { LEARNING_PIPELINE, SKILL_REVIEW } from '../../../shared/constants';
import type { SkillDraftOrigin } from '../../../shared/contract/agent';
import { scanSkillContent } from '../../security/skillContentGuard';
import {
  isLowValueSkillName,
  type ReviewedSkillApplicability,
} from '../../lightMemory/conversationReview';
import { createLogger } from '../infra/logger';
import { parseSkillMd } from './skillParser';
import { hasSkillApplicabilityBoundary } from './skillApplicability';
import {
  getDistillPositiveEvidenceCount,
  getSkillPromotionEvidenceThreshold,
  registerDistilledSkillPromotion,
} from './distillSignalStore';

export type { SkillDraftOrigin };

const logger = createLogger('SkillDraftQueue');

const DRAFT_META_FILENAME = 'draft.json';
const REJECTED_LEDGER_FILENAME = 'rejected.json';
const ACCEPTED_LEDGER_FILENAME = 'accepted.json';

interface RejectedLedgerEntry {
  patternKey: string;
  rejectedAt: number;
}

interface AcceptedLedgerEntry {
  patternKey: string;
  skillName?: string;
  acceptedAt?: number;
}

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
  applicability?: ReviewedSkillApplicability;
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
    // telemetry 草稿的工具序列本身就是可判适用边界；转正后缺工具时自动隐藏。
    fm.push(`requires_tools: [${input.toolSequence.join(', ')}]`);
  }
  if (input.applicability) {
    const fields: Array<[string, string[]]> = [
      ['requires_tools', input.applicability.requiresTools],
      ['platforms', input.applicability.platforms],
      ['required_env', input.applicability.requiredEnv],
      ['requires_paths', input.applicability.requiresPaths],
    ];
    for (const [key, values] of fields) {
      if (values.length > 0 && !(key === 'requires_tools' && input.toolSequence?.length)) {
        fm.push(`${key}: ${JSON.stringify(values)}`);
      }
    }
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
  if (input.body?.trim()) {
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

async function loadRejectedEntries(now = Date.now()): Promise<RejectedLedgerEntry[]> {
  try {
    const raw = await fs.readFile(getRejectedLedgerPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const entries = new Map<string, RejectedLedgerEntry>();
    for (const entry of parsed) {
      // v1 ledger stored bare pattern keys. Keep them safely in cooldown from
      // the first read rather than corrupting or permanently blocking them.
      if (typeof entry === 'string' && entry.trim()) {
        entries.set(entry, { patternKey: entry, rejectedAt: now });
        continue;
      }
      if (
        typeof entry === 'object'
        && entry !== null
        && typeof (entry as { patternKey?: unknown }).patternKey === 'string'
        && typeof (entry as { rejectedAt?: unknown }).rejectedAt === 'number'
      ) {
        const value = entry as RejectedLedgerEntry;
        if (value.patternKey.trim() && Number.isFinite(value.rejectedAt)) {
          entries.set(value.patternKey, value);
        }
      }
    }
    return Array.from(entries.values());
  } catch {
    return [];
  }
}

function isRejectionCoolingDown(entry: RejectedLedgerEntry, now: number): boolean {
  return now < entry.rejectedAt + SKILL_REVIEW.REJECTION_COOLDOWN_MS;
}

async function saveRejectedEntries(entries: RejectedLedgerEntry[]): Promise<void> {
  await fs.mkdir(getSkillDraftsDir(), { recursive: true });
  await fs.writeFile(getRejectedLedgerPath(), JSON.stringify(entries, null, 2), 'utf-8');
}

// accepted ledger：草稿确认入库后记账，避免同一 pattern 跨会话反复蒸馏打扰用户。
// 注：读-改-写无文件锁——失效的最坏后果只是"多弹一次确认卡"（非数据/安全损失），
// 故不引入锁/原子写的复杂度；但文件损坏要告警，避免 fail-open 静默丢失全部记录。
async function loadAcceptedEntries(): Promise<Map<string, AcceptedLedgerEntry>> {
  let raw: string;
  try {
    raw = await fs.readFile(getAcceptedLedgerPath(), 'utf-8');
  } catch {
    return new Map(); // 文件不存在属正常
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Map();
    const entries = new Map<string, AcceptedLedgerEntry>();
    for (const item of parsed) {
      if (typeof item === 'string' && item.trim()) {
        entries.set(item, { patternKey: item });
        continue;
      }
      if (
        typeof item === 'object'
        && item !== null
        && typeof (item as { patternKey?: unknown }).patternKey === 'string'
      ) {
        const entry = item as AcceptedLedgerEntry;
        if (entry.patternKey.trim()) entries.set(entry.patternKey, entry);
      }
    }
    return entries;
  } catch {
    logger.warn('Accepted ledger corrupted, treating as empty (may re-prompt previously accepted skills)');
    return new Map();
  }
}

async function loadAcceptedKeys(): Promise<Set<string>> {
  return new Set((await loadAcceptedEntries()).keys());
}

async function recordAcceptedKey(patternKey: string, skillName: string, acceptedAt: number): Promise<void> {
  if (!patternKey) return;
  const accepted = await loadAcceptedEntries();
  accepted.set(patternKey, { patternKey, skillName, acceptedAt });
  await fs.mkdir(getSkillDraftsDir(), { recursive: true });
  await fs.writeFile(getAcceptedLedgerPath(), JSON.stringify(Array.from(accepted.values()), null, 2), 'utf-8');
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
 * 把成功模式入队为草稿。同一 patternKey 已在队列中、已被接受，或仍在拒绝冷却期则跳过。
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
  /** LLM 复盘生成的机器可判适用字段；语义 [IF] 已固化在 body */
  applicability?: ReviewedSkillApplicability;
  timestamp?: number;
}): Promise<SkillDraftMeta | null> {
  const createdAt = input.timestamp ?? Date.now();
  const origin: SkillDraftOrigin = input.origin ?? 'telemetry-distilled';

  // 空 patternKey 无法去重（确认/拒绝后还会反复入队），直接拒绝入队
  if (!input.patternKey?.trim()) {
    logger.warn('Skill draft rejected: empty patternKey', { name: input.name });
    return null;
  }

  // 防御性命名闸：泛词 / 纯工具名拼接（bash-bash-bash 这类）一律不入队。
  // 上游 conversationReview 已先过一道，这里兜底，杜绝低价值草稿落盘。
  if (isLowValueSkillName(input.name)) {
    logger.debug('Skill draft rejected: low-value name', { name: input.name });
    return null;
  }

  const [existing, rejected, accepted] = await Promise.all([
    listSkillDrafts(),
    loadRejectedEntries(),
    loadAcceptedKeys(),
  ]);
  if (rejected.some((entry) => entry.patternKey === input.patternKey && isRejectionCoolingDown(entry, Date.now()))) {
    logger.debug('Skill draft skipped (rejection cooldown active)', { patternKey: input.patternKey });
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
    applicability: input.applicability,
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

    // ADR-034 层③：没有机器元数据，也没有语义 [IF] 边界的草稿不得转正。
    // 在确认时检查，允许用户先在待确认目录补写边界再重试。
    const parsedDraft = await parseSkillMd(draftDir, 'user');
    if (!hasSkillApplicabilityBoundary(parsedDraft)) {
      logger.warn('Skill draft blocked: missing applicability boundary', { id, name: meta.name });
      return {
        success: false,
        error: '草稿缺少适用条件：请声明机器可判 frontmatter，或在正文补充 [IF 条件]。',
      };
    }

    // ADR-034 层④：草稿照常生成和保留，但转正必须拿到 N 个不同真实会话的正向证据。
    // DB 不可用时 fail-closed，不能把“无法核验”当成“证据足够”。
    const positiveEvidence = getDistillPositiveEvidenceCount(meta.patternKey);
    const requiredEvidence = getSkillPromotionEvidenceThreshold();
    if (positiveEvidence === null || positiveEvidence < requiredEvidence) {
      logger.info('Skill draft promotion blocked: insufficient positive usage evidence', {
        id,
        name: meta.name,
        positiveEvidence,
        requiredEvidence,
      });
      return {
        success: false,
        error: positiveEvidence === null
          ? '使用证据账本不可用，无法安全转正。'
          : `真实使用正向证据不足：当前 ${positiveEvidence} 次，至少需要 ${requiredEvidence} 次。`,
      };
    }

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

    const acceptedAt = Date.now();
    const lifecycle = registerDistilledSkillPromotion({
      skillName: meta.name,
      patternKey: meta.patternKey,
      promotedAt: acceptedAt,
    });
    if (!lifecycle) {
      return { success: false, error: '使用证据账本写入失败，草稿未转正。' };
    }

    const skillsDir = getSkillsDir(workingDirectory);
    const targetDir = path.join(skillsDir.user.new, meta.name);
    await fs.mkdir(targetDir, { recursive: true });

    const skillPath = path.join(targetDir, 'SKILL.md');
    await fs.writeFile(skillPath, skillContent, 'utf-8');
    await fs.rm(draftDir, { recursive: true, force: true });
    // 记入 accepted ledger：同一 pattern 已采纳后不再跨会话重复蒸馏打扰
    await recordAcceptedKey(meta.patternKey, meta.name, acceptedAt);

    logger.info('Skill draft confirmed and installed', { id, name: meta.name, skillPath });
    return { success: true, skillPath };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to confirm skill draft', { id, error: message });
    return { success: false, error: message };
  }
}

/**
 * 用户拒绝草稿：删除草稿并记入 rejected ledger，30 天内不重复打扰。
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
      const rejectedAt = Date.now();
      const rejected = await loadRejectedEntries(rejectedAt);
      const entries = rejected.filter((entry) => entry.patternKey !== patternKey);
      entries.push({ patternKey, rejectedAt });
      await saveRejectedEntries(entries);
    }
    logger.info('Skill draft rejected', { id, patternKey });
    return { success: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, error: message };
  }
}
