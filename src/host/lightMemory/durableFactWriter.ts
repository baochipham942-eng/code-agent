// ============================================================================
// Durable Fact Writer — 将会话判断器提炼的长期事实写入 Light Memory
// ============================================================================

import { guardSensitiveText } from '../security/sensitiveDataGuard';
import { createLogger } from '../services/infra/logger';
import { SESSION_JUDGE } from '../../shared/constants';
import type { DurableFact } from './conversationJudge';
import { rebuildLightMemoryIndex, writeLightMemoryFile } from './lightMemoryIpc';

const logger = createLogger('DurableFactWriter');

function guardFactText(value: string, maxLength?: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    ...(maxLength === undefined ? {} : { maxLength }),
  }).trim();
}

export async function writeDurableFacts(
  facts: DurableFact[],
): Promise<{ written: number; skipped: number; files: string[] }> {
  // N-EVAL-MEMORY：files 只收真写成的那几份——skipped 的文件名不能混进来，
  // 否则 memory_written 事件会把「写失败」报成「写进去了」。
  const files: string[] = [];
  let written = 0;
  let skipped = 0;

  for (const fact of facts) {
    try {
      const name = guardFactText(fact.name);
      const description = guardFactText(fact.description);
      const content = guardFactText(fact.content, SESSION_JUDGE.MAX_DURABLE_FACT_CHARS);
      if (!name || !description || !content) {
        throw new Error('脱敏后的长期事实缺少必要内容');
      }

      await writeLightMemoryFile({
        filename: fact.filename,
        name,
        description,
        type: fact.type,
        content,
      });
      written += 1;
      files.push(fact.filename);
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

  return { written, skipped, files };
}
