// ============================================================================
// Durable Fact Writer — 将会话判断器提炼的长期事实写入 Light Memory
// N-MEM-WRITECONF：按判断器置信度分层写入（<0.5 丢弃 / 中间 candidate / ≥0.8 active），
// user/feedback 的 supersedes 在新条目转正后软归档旧条目。
// N-MEM-WRITECONF r2：candidate 绝不原地覆盖同名 active 条目——writeLightMemoryFile 按
// filename 原子覆盖，直接写会把已确认记忆降级出 INDEX，复核驳回后原事实彻底丢失。
// 改写到派生文件名并把待替换链接记在 deprecated_by，转正（approve）时才归档旧条目。
// N-MEM-WRITECONF r3：supersedes 归档两侧类型门——新事实与旧条目的 type 都必须 ∈
// user/feedback 才允许自动归档。directive 经交互确认门建立，project/reference 是
// 任务性材料，都不允许被会话收尾的一次模型判断静默移出 INDEX；本文件所有
// archiveMemoryFile 调用都不传 directiveConfirmedByUser（自动路径不自授确认权）。
// ============================================================================

import { createHash } from 'crypto';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import type { DurableFact } from './conversationJudge';
import {
  LIGHT_MEMORY_FILENAME_MAX,
  archiveMemoryFile,
  readMemoryFile,
  rebuildLightMemoryIndex,
  sanitizeLightMemoryFilename,
  writeLightMemoryFile,
} from './lightMemoryIpc';

const logger = createLogger('DurableFactWriter');

const SUPERSEDES_TYPES = new Set<string>(SESSION_JUDGE.DURABLE_FACT_SUPERSEDES_TYPES);

type DurableFactTier = 'candidate' | 'active';

function tierForConfidence(confidence: number): DurableFactTier | 'drop' {
  if (confidence < SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_DROP_BELOW) return 'drop';
  if (confidence >= SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_ACTIVE_MIN) return 'active';
  return 'candidate';
}

function guardFactText(value: string, maxLength?: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    ...(maxLength === undefined ? {} : { maxLength }),
  }).trim();
}

/**
 * 同名 active 条目的 candidate 改写名：<base>.candidate-<hash8>.md。
 * hash 取（目标文件名 + 正文）——同一事实同样措辞的重复改写落到同一派生名，
 * 覆盖上次待复核的 candidate 而不是每次会话堆积一个；措辞变化得到新文件。
 * base 按 LIGHT_MEMORY_FILENAME_MAX 预留后缀预算：写入侧 sanitize 会把去扩展名
 * 部分截到该上限，base 不预留时 hash 后缀被截掉，不同措辞会撞同一个派生名。
 */
function divertedCandidateFilename(target: string, content: string): string {
  const base = target.trim().replace(/\.md$/i, '');
  const shortid = createHash('sha256').update(`${target}\n${content}`).digest('hex').slice(0, 8);
  const suffix = `.candidate-${shortid}`;
  return `${base.slice(0, LIGHT_MEMORY_FILENAME_MAX - suffix.length)}${suffix}.md`;
}

/**
 * 旧条目可否被自动 supersedes 顶替：新旧两侧 type 都必须 ∈ user/feedback。
 * directive 的建立要过交互确认门（directiveConfirmedByUser），自动归档等于
 * 一次模型判断就撤销用户确认过的约束；project/reference 是任务性材料。
 */
function isAutoSupersedeable(oldType: string, newType: string): boolean {
  return SUPERSEDES_TYPES.has(oldType) && SUPERSEDES_TYPES.has(newType);
}

function logUnsupersedeableOld(oldType: string, supersedes: string, context: string): void {
  logger.info('旧条目类型不允许被自动 supersedes 归档，保持原样', {
    oldType,
    supersedes,
    context,
    allowed: SESSION_JUDGE.DURABLE_FACT_SUPERSEDES_TYPES,
  });
}

/**
 * candidate 写入目标的裁决：返回实际写入的文件名与待替换链接（记入 frontmatter
 * deprecated_by，approve 转正时消费）。同名 active 条目必须让路改写派生文件名；
 * 判断器显式声明的 supersedes（旧条目真实存在且两侧类型都可自动顶替）也在此登记
 * 为待替换。查找一律用 sanitize 后的名字——磁盘上的文件名都是写入侧规范化的产物。
 */
async function resolveCandidateTarget(
  fact: DurableFact,
  content: string,
): Promise<{ filename: string; pendingReplace: string | null }> {
  const existing = await readMemoryFile(sanitizeLightMemoryFilename(fact.filename));
  if (existing?.status === 'active') {
    // 同名冲突一律改写派生文件名（r2 防覆盖）；但只有旧条目可自动顶替时才登记
    // 待替换链接——否则转正时会经 archiveMemoryFile 归档一个不该被自动移除的条目。
    if (!isAutoSupersedeable(existing.type, fact.type)) {
      logUnsupersedeableOld(existing.type, existing.filename, 'candidate 同名冲突');
      return { filename: divertedCandidateFilename(existing.filename, content), pendingReplace: null };
    }
    return {
      filename: divertedCandidateFilename(existing.filename, content),
      pendingReplace: existing.filename,
    };
  }
  if (fact.supersedes && SUPERSEDES_TYPES.has(fact.type)) {
    const superseded = await readMemoryFile(sanitizeLightMemoryFilename(fact.supersedes));
    if (superseded) {
      if (isAutoSupersedeable(superseded.type, fact.type)) {
        return { filename: fact.filename, pendingReplace: superseded.filename };
      }
      logUnsupersedeableOld(superseded.type, superseded.filename, 'candidate supersedes');
      return { filename: fact.filename, pendingReplace: null };
    }
    logger.warn('supersedes 指向的记忆文件不存在，candidate 未记录待替换链接', {
      supersedes: fact.supersedes,
    });
  }
  return { filename: fact.filename, pendingReplace: null };
}

/**
 * supersedes 软归档：仅新旧两侧 type ∈ user/feedback、仅旧文件真实存在、仅新条目
 * 已写成为 active 时执行。指向缺失文件或旧条目类型不可自动移除（directive /
 * project / reference）一律忽略并留痕，绝不抛出（不连累已写成的新条目）。
 */
async function archiveSupersededFact(fact: DurableFact, writtenFilename: string): Promise<boolean> {
  if (!fact.supersedes) return false;
  if (!SUPERSEDES_TYPES.has(fact.type)) {
    logger.info('supersedes 仅对 user/feedback 类型生效，已忽略', {
      type: fact.type,
      supersedes: fact.supersedes,
    });
    return false;
  }
  const old = await readMemoryFile(sanitizeLightMemoryFilename(fact.supersedes));
  if (!old) {
    logger.warn('supersedes 指向的记忆文件不存在，未归档', { supersedes: fact.supersedes });
    return false;
  }
  if (!isAutoSupersedeable(old.type, fact.type)) {
    logUnsupersedeableOld(old.type, old.filename, 'active supersedes');
    return false;
  }
  await archiveMemoryFile(old.filename, writtenFilename);
  logger.info('supersedes 已软归档旧记忆', {
    superseded: old.filename,
    deprecatedBy: writtenFilename,
  });
  return true;
}

export async function writeDurableFacts(
  facts: DurableFact[],
): Promise<{
  written: number;
  skipped: number;
  files: string[];
  active: number;
  candidate: number;
  dropped: number;
}> {
  // N-EVAL-MEMORY：files 只收真写成的那几份——skipped/dropped 的文件名不能混进来，
  // 否则 memory_written 事件会把「写失败」报成「写进去了」。
  const files: string[] = [];
  let written = 0;
  let skipped = 0;
  let active = 0;
  let candidate = 0;
  let dropped = 0;

  for (const fact of facts) {
    const tier = tierForConfidence(fact.confidence);
    if (tier === 'drop') {
      // 计入 skipped 并留痕：丢弃是判断器质量门的决定，不是静默失败。
      dropped += 1;
      skipped += 1;
      logger.info('低置信度长期事实已丢弃', {
        filename: fact.filename,
        confidence: fact.confidence,
        dropBelow: SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_DROP_BELOW,
      });
      continue;
    }

    try {
      const name = guardFactText(fact.name);
      const description = guardFactText(fact.description);
      const content = guardFactText(fact.content, SESSION_JUDGE.MAX_DURABLE_FACT_CHARS);
      if (!name || !description || !content) {
        throw new Error('脱敏后的长期事实缺少必要内容');
      }

      // r2：candidate 先裁决写入目标——同名 active 条目在场时绝不原地覆盖。
      const target = tier === 'candidate'
        ? await resolveCandidateTarget(fact, content)
        : { filename: fact.filename, pendingReplace: null as string | null };

      const file = await writeLightMemoryFile({
        filename: target.filename,
        name,
        description,
        type: fact.type,
        content,
        status: tier,
        ...(target.pendingReplace ? { deprecatedBy: target.pendingReplace } : {}),
      });
      written += 1;
      files.push(file.filename);
      if (tier === 'candidate') candidate += 1;
      else active += 1;

      // 新条目是 candidate 时旧条目保持生效：待替换链接只登记（deprecated_by），
      // 归档推迟到复核 approve 转正时（memoryEntryRuntime.updateMemoryEntry 消费）。
      if (tier === 'active') {
        try {
          await archiveSupersededFact(fact, file.filename);
        } catch (error) {
          logger.warn('supersedes 归档旧记忆失败，新条目不受影响', {
            supersedes: fact.supersedes,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } catch (error) {
      skipped += 1;
      logger.warn('写入长期事实失败，已跳过该条', {
        filename: fact.filename,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (written > 0) {
    try {
      await rebuildLightMemoryIndex();
    } catch (error) {
      logger.warn('重建 Light Memory 索引失败', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { written, skipped, files, active, candidate, dropped };
}
