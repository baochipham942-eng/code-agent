// ============================================================================
// Durable Fact Writer — 将会话判断器提炼的长期事实写入 Light Memory
// N-MEM-WRITECONF r5（final scope cut）：candidate 档整体移除（连续 5 轮审查都在
// 该机制上发现新的数据丢失洞）。唯一保留的质量门是置信度：< DROP_BELOW 丢弃留痕；
// 其余（含判断器漏给置信度的 MISSING_DEFAULT）按 origin/main 的原行为写 active——
// 不写 status（读侧按缺省 active 处理）、同名原地覆盖、无派生文件名。
// supersedes 只作为链接记录在新条目 frontmatter 的 supersedes 字段上，本单不消费；
// 判断器输出没有任何归档/降级/改写既有条目的路径。
// ============================================================================

import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import type { DurableFact } from './conversationJudge';
import {
  readMemoryFile,
  rebuildLightMemoryIndex,
  sanitizeLightMemoryFilename,
  writeLightMemoryFile,
} from './lightMemoryIpc';

const logger = createLogger('DurableFactWriter');

function guardFactText(value: string, maxLength?: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    ...(maxLength === undefined ? {} : { maxLength }),
  }).trim();
}

/**
 * supersedes 链接的裁决（r5：只记录、不归档）。链接指向的文件必须真实存在，
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

export async function writeDurableFacts(
  facts: DurableFact[],
): Promise<{
  written: number;
  skipped: number;
  files: string[];
  active: number;
  dropped: number;
}> {
  // N-EVAL-MEMORY：files 只收真写成的那几份——skipped/dropped 的文件名不能混进来，
  // 否则 memory_written 事件会把「写失败」报成「写进去了」。
  const files: string[] = [];
  let written = 0;
  let skipped = 0;
  let active = 0;
  let dropped = 0;

  for (const fact of facts) {
    // r5：唯一新增的质量门。丢弃是判断器置信度的决定，不是写入失败——
    // 只计入 dropped 并留痕，skipped 保留给真正的写入失败。
    if (fact.confidence < SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_DROP_BELOW) {
      dropped += 1;
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

      // r5：与 origin/main 同一写入形状——不传 status（main 也不传，读侧按缺省
      // active 处理）、同名原地覆盖。supersedes 仅当指向真实存在的文件时追加
      // 一行链接字段，除此之外逐字节与 main 的产物一致。
      const supersedeLink = await resolveSupersedeLink(fact);
      const file = await writeLightMemoryFile({
        filename: fact.filename,
        name,
        description,
        type: fact.type,
        content,
        ...(supersedeLink ? { supersedes: supersedeLink } : {}),
      });
      written += 1;
      active += 1;
      files.push(file.filename);
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

  return { written, skipped, files, active, dropped };
}
