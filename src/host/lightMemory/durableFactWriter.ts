// ============================================================================
// Durable Fact Writer — 将会话判断器提炼的长期事实写入 Light Memory
// N-MEM-WRITECONF：按判断器置信度分层写入（<0.5 丢弃 / 中间 candidate / ≥0.8 active）。
// N-MEM-WRITECONF r4（scope cut）：① candidate 绝不指向任何已存在的同名文件——只看
// 文件存在性，不看 status（本 PR 之前 writeDurableFacts 不写 status，存量文件没有
// status 行，INDEX 与 lightMemoryFileToEntry 都按缺省 active 处理）；同名时一律改落
// 派生文件名。② 本 PR 不再有任何「判断器输出 → 归档/降级旧条目」的代码路径：
// supersedes 只作为链接记录在新条目 frontmatter deprecated_by 上，留给后续工单消费。
// 高置信度同名写入保持 main 基线行为（原地覆盖为 active）。
// ============================================================================

import { createHash } from 'crypto';
import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import type { DurableFact } from './conversationJudge';
import {
  LIGHT_MEMORY_FILENAME_MAX,
  readMemoryFile,
  rebuildLightMemoryIndex,
  sanitizeLightMemoryFilename,
  writeLightMemoryFile,
} from './lightMemoryIpc';

const logger = createLogger('DurableFactWriter');

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
 * 同名已存在文件的 candidate 改写名：<base>.candidate-<hash8>.md。
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
 * supersedes 链接的裁决（r4：只记录、不归档）。链接指向的文件必须真实存在，
 * 指向缺失文件只 warn 留痕、不记链接、不抛错。查找一律用 sanitize 后的名字——
 * 磁盘上的文件名都是写入侧规范化的产物。
 */
async function resolveSupersedeLink(fact: DurableFact): Promise<string | null> {
  if (!fact.supersedes) return null;
  const superseded = await readMemoryFile(sanitizeLightMemoryFilename(fact.supersedes));
  if (!superseded) {
    logger.warn('supersedes 指向的记忆文件不存在，未记录取代链接', { supersedes: fact.supersedes });
    return null;
  }
  return superseded.filename;
}

/**
 * candidate 写入目标的裁决（r4：只看文件存在性）。同名文件存在——无论 status 是
 * active/candidate/rejected/stale/archived 还是没有 status 行的存量文件——candidate
 * 都改落派生文件名，绝不原地覆盖（writeLightMemoryFile 按 filename 原子覆盖，直接写
 * 会把已在生效或待复核的记忆改写丢掉）。无同名冲突时沿用判断器给的名字；
 * 显式 supersedes 记录为链接。碰撞链接优先于显式 supersedes：同名文件才是内容上
 * 被顶替的那个。链接只记在新条目 frontmatter deprecated_by 上，本单不消费。
 */
async function resolveCandidateTarget(
  fact: DurableFact,
  content: string,
): Promise<{ filename: string; supersedeLink: string | null }> {
  const existing = await readMemoryFile(sanitizeLightMemoryFilename(fact.filename));
  if (existing) {
    return {
      filename: divertedCandidateFilename(existing.filename, content),
      supersedeLink: existing.filename,
    };
  }
  return { filename: fact.filename, supersedeLink: await resolveSupersedeLink(fact) };
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

      // r4：candidate 先裁决写入目标——同名文件存在（任意 status）即改写派生文件名；
      // active 保持 main 基线（同名原地覆盖）。supersedes 在两档都只记录链接，
      // 本函数没有任何归档/降级旧条目的路径（r4 scope cut，交给后续工单）。
      const target = tier === 'candidate'
        ? await resolveCandidateTarget(fact, content)
        : { filename: fact.filename, supersedeLink: await resolveSupersedeLink(fact) };

      const file = await writeLightMemoryFile({
        filename: target.filename,
        name,
        description,
        type: fact.type,
        content,
        status: tier,
        ...(target.supersedeLink ? { deprecatedBy: target.supersedeLink } : {}),
      });
      written += 1;
      files.push(file.filename);
      if (tier === 'candidate') candidate += 1;
      else active += 1;
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
