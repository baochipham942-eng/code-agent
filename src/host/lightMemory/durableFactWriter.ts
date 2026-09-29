// ============================================================================
// Durable Fact Writer — 将会话判断器提炼的长期事实写入 Light Memory
// N-MEM-WRITECONF：按判断器置信度分层写入（<0.5 丢弃 / 中间 candidate / ≥0.8 active），
// user/feedback 的 supersedes 在新条目转正后软归档旧条目。
// ============================================================================

import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import type { DurableFact } from './conversationJudge';
import {
  archiveMemoryFile,
  readMemoryFile,
  rebuildLightMemoryIndex,
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
 * supersedes 软归档：仅 user/feedback、仅旧文件真实存在、仅新条目已写成为 active 时执行。
 * 指向缺失文件或 project/reference 一律忽略并留痕，绝不抛出（不连累已写成的新条目）。
 */
async function archiveSupersededFact(fact: DurableFact, writtenFilename: string): Promise<boolean> {
  if (!fact.supersedes) return false;
  if (!(SESSION_JUDGE.DURABLE_FACT_SUPERSEDES_TYPES as readonly string[]).includes(fact.type)) {
    logger.info('supersedes 仅对 user/feedback 类型生效，已忽略', {
      type: fact.type,
      supersedes: fact.supersedes,
    });
    return false;
  }
  const old = await readMemoryFile(fact.supersedes);
  if (!old) {
    logger.warn('supersedes 指向的记忆文件不存在，未归档', { supersedes: fact.supersedes });
    return false;
  }
  await archiveMemoryFile(fact.supersedes, writtenFilename);
  logger.info('supersedes 已软归档旧记忆', {
    superseded: fact.supersedes,
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

      const file = await writeLightMemoryFile({
        filename: fact.filename,
        name,
        description,
        type: fact.type,
        content,
        status: tier,
      });
      written += 1;
      files.push(file.filename);
      if (tier === 'candidate') candidate += 1;
      else active += 1;

      // 新条目是 candidate 时旧条目保持生效（等复核转正后才算被取代）。
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
