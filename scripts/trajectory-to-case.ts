#!/usr/bin/env npx tsx
// ============================================================================
// trajectory:to-case — 回流桥 CLI（批 1 B1）
// ----------------------------------------------------------------------------
// 把本地 telemetry 里的真实坏信号抽成回归用例 YAML 草稿：
//   --from-feedback  用户点踩（telemetry_feedback rating=-1）
//   --from-quality   turnQuality 总评 risk 的回合
//   --from-journal   failure journal 已沉淀的失败模式
// 草稿落 .claude/test-cases/drafts/（正式 loader 不加载），expect 留空待人工硬化。
// 只读：数据库以 readonly 打开，绝不写 live 数据。
// ============================================================================

import { mkdir, writeFile, access } from 'fs/promises';
import { homedir } from 'os';
import path from 'path';
import process from 'process';
import Database from 'better-sqlite3';
import {
  buildDraftYaml,
  draftFileName,
  journalPatternToDraftSeed,
  queryNegativeFeedback,
  resolveFeedbackPrompt,
  resolveTurnPrompt,
  selectRiskTurnMessages,
  type DraftSeed,
  type DraftSource,
} from '../src/host/evaluation/trajectoryToCase';
import type { Message } from '../src/shared/contract';

const HELP = `trajectory:to-case — 坏信号 → 回归用例草稿

用法:
  npm run trajectory:to-case -- --from-feedback [--from-quality] [--from-journal] [选项]

入口（至少一个）:
  --from-feedback   点踩反馈（rating=-1）
  --from-quality    turnQuality 总评 risk 的回合
  --from-journal    failure journal 失败模式（prompt 为占位，review 时替换）

选项:
  --data-dir <dir>  数据目录（默认 $CODE_AGENT_DATA_DIR 或 ~/.code-agent）
  --out-dir <dir>   草稿输出目录（默认 <repo>/.claude/test-cases/drafts）
  --limit <n>       每入口最多生成条数（默认 5）
  --json            结果输出 JSON
  --help            本帮助
`;

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readFlagValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) {
    return process.argv[index + 1];
  }
  return undefined;
}

function resolveDataDir(): string {
  const flag = readFlagValue('--data-dir');
  if (flag) return path.resolve(flag);
  if (process.env.CODE_AGENT_DATA_DIR?.trim()) return path.resolve(process.env.CODE_AGENT_DATA_DIR.trim());
  return path.join(homedir(), '.code-agent');
}

interface RawMessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string | null;
  timestamp: number;
  metadata: string | null;
}

function rowToMessage(row: RawMessageRow): Message {
  let metadata: Record<string, unknown> | undefined;
  if (row.metadata) {
    try {
      metadata = JSON.parse(row.metadata) as Record<string, unknown>;
    } catch {
      metadata = undefined;
    }
  }
  return {
    id: row.id,
    role: row.role,
    content: row.content ?? '',
    timestamp: row.timestamp,
    metadata,
  } as Message;
}

function getSessionMessages(db: InstanceType<typeof Database>, sessionId: string): Message[] {
  const rows = db
    .prepare('SELECT id, session_id, role, content, timestamp, metadata FROM messages WHERE session_id = ? ORDER BY timestamp ASC')
    .all(sessionId) as RawMessageRow[];
  return rows.map(rowToMessage);
}

async function main(): Promise<void> {
  if (hasFlag('--help') || process.argv.length <= 2) {
    console.log(HELP);
    return;
  }

  const fromFeedback = hasFlag('--from-feedback');
  const fromQuality = hasFlag('--from-quality');
  const fromJournal = hasFlag('--from-journal');
  if (!fromFeedback && !fromQuality && !fromJournal) {
    console.error('至少指定一个入口：--from-feedback / --from-quality / --from-journal\n');
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const limit = Math.max(1, Math.min(50, Number(readFlagValue('--limit') ?? 5)));
  const dataDir = resolveDataDir();
  const outDir = path.resolve(readFlagValue('--out-dir') ?? path.join(process.cwd(), '.claude', 'test-cases', 'drafts'));
  const dbPath = path.join(dataDir, 'code-agent.db');

  const seeds: DraftSeed[] = [];
  const skipped: string[] = [];

  const needsDb = fromFeedback || fromQuality;
  let db: InstanceType<typeof Database> | null = null;
  if (needsDb) {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });
  }

  try {
    if (fromFeedback && db) {
      const feedback = queryNegativeFeedback(db, { limit });
      feedback.forEach((row, index) => {
        // web 会话的 user 输入只在 telemetry_turns，messages 回溯是桌面路径兜底
        const prompt = resolveTurnPrompt(db!, row.sessionId, { turnId: row.turnId, anchorTimestamp: row.createdAt })
          ?? resolveFeedbackPrompt(getSessionMessages(db!, row.sessionId), { messageId: row.messageId, turnId: row.turnId });
        if (!prompt) {
          skipped.push(`feedback:${row.id}（会话 ${row.sessionId} 无 user 原话）`);
          return;
        }
        seeds.push({
          id: `draft-feedback-${row.sessionId}-${index}`,
          source: 'feedback',
          prompt,
          sourceSessionId: row.sessionId,
          note: `用户点踩${row.comment ? `：${row.comment}` : ''}`,
        });
      });
    }

    if (fromQuality && db) {
      const riskRows = db
        .prepare(
          `SELECT id, session_id, role, content, timestamp, metadata FROM messages
           WHERE role = 'assistant' AND metadata LIKE '%turnQuality%'
           ORDER BY timestamp DESC LIMIT 500`,
        )
        .all() as RawMessageRow[];
      const riskMessages = selectRiskTurnMessages(riskRows.map(rowToMessage))
        .slice(0, limit);
      riskMessages.forEach((message, index) => {
        const sessionId = riskRows.find((r) => r.id === message.id)?.session_id ?? 'unknown-session';
        const prompt = resolveTurnPrompt(db!, sessionId, { turnId: null, anchorTimestamp: message.timestamp ?? null })
          ?? resolveFeedbackPrompt(getSessionMessages(db!, sessionId), { messageId: message.id, turnId: message.id });
        if (!prompt) {
          skipped.push(`quality:${message.id}（会话 ${sessionId} 无 user 原话）`);
          return;
        }
        seeds.push({
          id: `draft-quality-${sessionId}-${index}`,
          source: 'quality',
          prompt,
          sourceSessionId: sessionId,
          note: 'turnQuality 总评 risk 回合',
        });
      });
    }
  } finally {
    db?.close();
  }

  if (fromJournal) {
    // 动态 import：failureJournal 按 CODE_AGENT_DATA_DIR 解析 Light Memory 路径，
    // 必须在 env 设定后再加载。
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    const { loadFailureJournalEntries } = await import('../src/host/lightMemory/failureJournal');
    const patterns = await loadFailureJournalEntries();
    patterns.slice(0, limit).forEach((pattern, index) => {
      const seedBase = journalPatternToDraftSeed(pattern);
      seeds.push({
        id: `draft-journal-${seedBase.sourceSessionId}-${index}`,
        source: 'journal',
        ...seedBase,
      });
    });
    if (patterns.length === 0) skipped.push('journal：无已沉淀失败模式');
  }

  await mkdir(outDir, { recursive: true });
  const written: string[] = [];
  const existed: string[] = [];
  const perSourceCounter = new Map<string, number>();

  for (const seed of seeds) {
    const counterKey = `${seed.source}:${seed.sourceSessionId}`;
    const index = perSourceCounter.get(counterKey) ?? 0;
    perSourceCounter.set(counterKey, index + 1);
    const fileName = draftFileName(seed.source as DraftSource, seed.sourceSessionId, index);
    const filePath = path.join(outDir, fileName);
    try {
      await access(filePath);
      existed.push(fileName);
      continue; // 幂等：已存在的草稿不覆盖（可能已被人工编辑）
    } catch {
      // 不存在 → 写入
    }
    // case id 与文件名对齐（文件名是幂等真源，seed.id 的临时序号作废）
    const alignedSeed = { ...seed, id: fileName.replace(/\.yaml$/, '') };
    await writeFile(filePath, buildDraftYaml(alignedSeed), 'utf-8');
    written.push(fileName);
  }

  const summary = {
    dataDir,
    outDir,
    generated: written,
    skippedExisting: existed,
    skippedNoPrompt: skipped,
  };
  if (hasFlag('--json')) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`草稿输出目录: ${outDir}`);
    console.log(`新生成 ${written.length} 个：${written.join(', ') || '无'}`);
    if (existed.length) console.log(`已存在跳过 ${existed.length} 个：${existed.join(', ')}`);
    if (skipped.length) console.log(`无法生成 ${skipped.length} 个：${skipped.join('; ')}`);
    if (written.length) console.log('\n下一步：按草稿顶部 checklist 人工补 deterministic 断言后移出 drafts/。');
  }
}

main().catch((error) => {
  console.error('trajectory:to-case failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
