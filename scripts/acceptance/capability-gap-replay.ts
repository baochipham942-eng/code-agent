#!/usr/bin/env npx tsx
// ============================================================================
// 缺口探测器离线回放（N-CAP1 验收工具）
// ============================================================================
// 把真实历史会话喂给探测器，看它到底认出了什么——不必等 dogfood 攒够两周。
// 方案 §二.5(1续B)「离线回放验收：上线前必须先跑，不靠上线试错」的 P0 版。
//
// 数据源：真库的 tool_execution_events（begin 行带 params_json）+ messages 的
// 用户消息时间戳做轮边界。**只读打开**（mode=ro），不写真库一个字节。
// 账本也不落用户目录：全程用临时 HOME，跑完即弃。
//
// 用法：
//   npx tsx scripts/acceptance/capability-gap-replay.ts [--db <path>] [--top 15] [--min-steps 2]

import Database from 'better-sqlite3';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

const args = process.argv.slice(2);
function option(name: string, fallback: string): string {
  const index = args.indexOf(name);
  return index === -1 ? fallback : (args[index + 1] ?? fallback);
}

const dbPath = option('--db', path.join(os.homedir(), '.code-agent', 'code-agent.db'));
const topN = Number(option('--top', '15'));

// 账本重定向到临时目录：回放绝不能污染真实的候选账本
const scratchHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cap-replay-'));
process.env.CODE_AGENT_CONFIG_DIR = scratchHome;

interface BeginRow {
  session_id: string | null;
  tool_name: string;
  params_json: string | null;
  status: string | null;
  error: string | null;
  summary: string | null;
  recorded_at: number;
  execution_id: string;
}

interface UserMessageRow {
  session_id: string;
  content: string;
  timestamp: number;
}

async function main(): Promise<void> {
  const { observeTurn, listCandidates } = await import('../../src/host/services/skills/capabilityGapDetector');
  const { getCapabilityCandidateStore } = await import('../../src/host/services/skills/capabilityCandidateStore');
  const store = getCapabilityCandidateStore();
  await store.load();

  // better-sqlite3 不吃 file: URI（除非开 uri 选项）；readonly:true 由驱动层强制，等价只读。
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });

  const begins = db.prepare(`
    SELECT session_id, tool_name, params_json, recorded_at, execution_id, summary
    FROM tool_execution_events WHERE phase = 'begin' AND session_id IS NOT NULL
    ORDER BY session_id, recorded_at
  `).all() as BeginRow[];

  const completes = new Map<string, { status: string | null; error: string | null }>();
  for (const row of db.prepare(`
    SELECT execution_id, status, error FROM tool_execution_events WHERE phase = 'complete'
  `).all() as Array<{ execution_id: string; status: string | null; error: string | null }>) {
    completes.set(row.execution_id, { status: row.status, error: row.error });
  }

  const userMessages = db.prepare(`
    SELECT session_id, content, timestamp FROM messages WHERE role = 'user' ORDER BY session_id, timestamp
  `).all() as UserMessageRow[];
  db.close();

  // 轮边界 = 相邻两条用户消息之间。这是真实的「一次用户请求」口径，
  // 不是 telemetry 的 turn_id（那是模型轮，一次请求会有好几个）。
  const boundariesBySession = new Map<string, UserMessageRow[]>();
  for (const message of userMessages) {
    const list = boundariesBySession.get(message.session_id) ?? [];
    list.push(message);
    boundariesBySession.set(message.session_id, list);
  }

  const bySession = new Map<string, BeginRow[]>();
  for (const row of begins) {
    const key = row.session_id!;
    const list = bySession.get(key) ?? [];
    list.push(row);
    bySession.set(key, list);
  }

  let turnsFed = 0;
  let stepsFed = 0;
  for (const [sessionId, rows] of bySession) {
    const boundaries = boundariesBySession.get(sessionId) ?? [];
    for (let i = 0; i < Math.max(boundaries.length, 1); i += 1) {
      const start = boundaries[i]?.timestamp ?? 0;
      const end = boundaries[i + 1]?.timestamp ?? Number.MAX_SAFE_INTEGER;
      const slice = rows.filter((row) => row.recorded_at >= start && row.recorded_at < end);
      if (slice.length === 0) continue;

      const steps = slice.map((row) => {
        const done = completes.get(row.execution_id);
        const success = done ? done.status === 'success' : true;
        let parsedArgs: Record<string, unknown> = {};
        try {
          parsedArgs = row.params_json ? JSON.parse(row.params_json) as Record<string, unknown> : {};
        } catch { /* 坏行按无参数处理 */ }
        return {
          toolCallId: row.execution_id,
          toolName: row.tool_name,
          args: parsedArgs,
          success,
          outputPreview: done?.error ?? row.summary ?? '',
          duration: 0,
          timestamp: row.recorded_at,
        };
      });

      // token 用量在回放里拿不到（真库按模型轮记账，与本轮口径对不上）——传 0，
      // 探测器会退化成纯步数成本。**不许在这里编一个数**。
      const recorded = observeTurn(
        { userMessage: boundaries[i]?.content ?? '', steps, tokens: 0 },
        slice[slice.length - 1].recorded_at,
      );
      if (recorded) { turnsFed += 1; stepsFed += steps.length; }
    }
  }

  const now = Date.now();
  const candidates = listCandidates(now);
  console.log(`\n库：${dbPath}`);
  console.log(`喂进探测器：${turnsFed} 轮 / ${stepsFed} 步（来自 ${bySession.size} 个会话的 ${begins.length} 条 begin 记录）`);
  console.log(`产出候选：${candidates.length} 条，其中进首屏 ${candidates.filter((c) => c.aboveFold).length} 条\n`);
  console.log('排名 | 首屏 | 分数 | 次数 | 均步 | 建议层级 | 工具组合 | 用户原话样例');
  console.log('-'.repeat(140));
  for (const [index, candidate] of candidates.slice(0, topN).entries()) {
    console.log([
      String(index + 1).padStart(2),
      candidate.aboveFold ? '✓' : ' ',
      candidate.mechanicalScore.toFixed(1).padStart(7),
      String(candidate.occurrences).padStart(4),
      candidate.avgSteps.toFixed(1).padStart(5),
      candidate.tier.padEnd(8),
      candidate.shapeTokens.join(', ').slice(0, 60),
      (candidate.sampleUserMessages[0] ?? '').replace(/\s+/g, ' ').slice(0, 40),
    ].join(' | '));
  }
  console.log('');
  fs.rmSync(scratchHome, { recursive: true, force: true });
}

void main();
