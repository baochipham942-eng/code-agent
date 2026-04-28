// ============================================================================
// Debug Command - 调试快照、回放与决策树
// ============================================================================
//
// 子命令:
//   stats                                          - 占用统计
//   clear [--older-than 1d|7d|30d|all] [--session] - 清理快照
//   session <id> [--json]                          - 列出某 session 的所有 turn 快照
//   context <id> [--turn N] [--json]               - 看具体某 turn 的完整上下文
//   loop trace <id> [--json]                       - 决策树（turn → 工具 → turn）
//
// 后续会扩展 tool dry-run / compact diff / replay 等。
// ============================================================================

import { Command } from 'commander';
import { execSync } from 'child_process';
import { initCLIDatabase } from '../database';
import { runToolDirectly } from './_runToolDirectly';
import { loadAllReplayCases, findReplayCase, type ReplayCase } from './_loadTestCase';
import type { CLIGlobalOptions } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseOlderThan(input: string | undefined): number | undefined {
  if (!input || input === 'all') return undefined;
  const match = /^(\d+)([dhm])$/i.exec(input.trim());
  if (!match) {
    throw new Error(`无效的 --older-than 值: ${input}（用 1d / 7d / 30d / all）`);
  }
  const n = parseInt(match[1]!, 10);
  const unit = match[2]!.toLowerCase();
  return unit === 'd' ? n * 86400_000 : unit === 'h' ? n * 3600_000 : n * 60_000;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  if (!ts) return '-';
  const d = new Date(ts);
  return d.toLocaleString('sv-SE').slice(0, 19); // YYYY-MM-DD HH:MM:SS
}

function pad(s: string | number, width: number, alignRight = false): string {
  const str = String(s);
  if (str.length >= width) return str;
  return alignRight ? str.padStart(width) : str.padEnd(width);
}

interface LooseSnapshot {
  id: string;
  sessionId: string;
  turnId: string | null;
  turnIndex: number;
  contextChunks: unknown;
  tokenBreakdown: unknown;
  byteSize: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// stats / clear
// ---------------------------------------------------------------------------

const statsCommand = new Command('stats')
  .description('显示调试快照占用统计')
  .action(async () => {
    const db = await initCLIDatabase();
    const turn = db.getSnapshotStats();
    const compact = db.getCompactionStats();
    console.log('调试快照统计:');
    console.log(`  Turn snapshots:    ${turn.snapshotCount} 条 / ${turn.sessionCount} session / ${formatBytes(turn.totalBytes)}`);
    console.log(`  Compaction snaps:  ${compact.snapshotCount} 条 / ${compact.sessionCount} session / ${formatBytes(compact.totalBytes)}`);
    console.log(`  合计:               ${turn.snapshotCount + compact.snapshotCount} 条 / ${formatBytes(turn.totalBytes + compact.totalBytes)}`);
  });

const clearCommand = new Command('clear')
  .description('清理调试快照（同时清 turn + compaction）')
  .option('--older-than <duration>', '只清理早于指定时间的（1d / 7d / 30d / all）', 'all')
  .option('--session <id>', '只清理指定 session 的快照')
  .option('--type <kind>', '只清某一种类型（turn / compact）')
  .action(async (options: { olderThan?: string; session?: string; type?: string }) => {
    const db = await initCLIDatabase();
    let olderThanMs: number | undefined;
    try {
      olderThanMs = parseOlderThan(options.olderThan);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
    let turnCleared = 0;
    let compactCleared = 0;
    if (!options.type || options.type === 'turn') {
      turnCleared = db.clearSnapshots({ olderThanMs, sessionId: options.session });
    }
    if (!options.type || options.type === 'compact') {
      compactCleared = db.clearCompactionSnapshots({ olderThanMs, sessionId: options.session });
    }
    console.log(`已清理 ${turnCleared} 条 turn snapshot + ${compactCleared} 条 compaction snapshot`);
  });

// ---------------------------------------------------------------------------
// session <id> — 列出某 session 的所有 turn
// ---------------------------------------------------------------------------

const sessionCommand = new Command('session')
  .description('列出某 session 的所有 turn 快照')
  .argument('<sessionId>', 'session ID')
  .option('--json', 'JSON 格式输出')
  .action(async (sessionId: string, options: { json?: boolean }) => {
    const db = await initCLIDatabase();
    const snapshots = db.listTurnSnapshots(sessionId, 1000) as LooseSnapshot[];
    const session = db.getSession(sessionId);

    if (options.json || process.argv.includes('--json')) {
      console.log(JSON.stringify({ session, snapshots }, null, 2));
      return;
    }

    if (!session) {
      console.log(`session ${sessionId} 不存在（可能已被删除，但快照可能还在）`);
    } else {
      console.log(`Session: ${session.id}`);
      console.log(`  Title:        ${session.title}`);
      console.log(`  Model:        ${session.modelConfig.provider}/${session.modelConfig.model}`);
      console.log(`  Status:       ${session.status}`);
      console.log(`  Created:      ${formatDate(session.createdAt)}`);
      console.log(`  Updated:      ${formatDate(session.updatedAt)}`);
      console.log(`  Messages:     ${session.messageCount}`);
      console.log('');
    }

    if (snapshots.length === 0) {
      console.log('（没有 turn 快照）');
      return;
    }

    console.log(`Turns (${snapshots.length}):`);
    console.log(
      `  ${pad('TURN', 6)}  ${pad('CREATED', 21)}  ${pad('IN→OUT TOKENS', 16, true)}  ${pad('SIZE', 10, true)}  ${pad('MSGS', 6, true)}  TURN_ID`,
    );
    console.log(`  ${'-'.repeat(6)}  ${'-'.repeat(21)}  ${'-'.repeat(16)}  ${'-'.repeat(10)}  ${'-'.repeat(6)}  ${'-'.repeat(20)}`);
    for (const s of snapshots) {
      const tok = s.tokenBreakdown as { inputTokens?: number; outputTokens?: number } | null;
      const ctx = s.contextChunks as { messageCount?: number } | null;
      const tokenStr = tok ? `${tok.inputTokens ?? 0}→${tok.outputTokens ?? 0}` : '-';
      const msgs = ctx?.messageCount ?? 0;
      console.log(
        `  ${pad(s.turnIndex, 6)}  ${pad(formatDate(s.createdAt), 21)}  ${pad(tokenStr, 16, true)}  ${pad(formatBytes(s.byteSize), 10, true)}  ${pad(msgs, 6, true)}  ${s.turnId ?? '-'}`,
      );
    }
  });

// ---------------------------------------------------------------------------
// context <id> [--turn N] — 单 turn 完整上下文
// ---------------------------------------------------------------------------

const contextCommand = new Command('context')
  .description('看具体某 turn 的完整上下文（默认最后一个 turn）')
  .argument('<sessionId>', 'session ID')
  .option('--turn <n>', 'turn 索引（1-based），默认最后一个')
  .option('--full', '完整显示消息内容（默认截断到 200 字符）')
  .option('--json', 'JSON 格式输出')
  .action(async (sessionId: string, options: { turn?: string; full?: boolean; json?: boolean }) => {
    const db = await initCLIDatabase();
    const snapshots = db.listTurnSnapshots(sessionId, 1000) as LooseSnapshot[];
    if (snapshots.length === 0) {
      console.error(`session ${sessionId} 没有 turn 快照`);
      process.exit(1);
    }

    const targetTurn = options.turn ? parseInt(options.turn, 10) : snapshots[snapshots.length - 1]!.turnIndex;
    const snap = snapshots.find((s) => s.turnIndex === targetTurn);
    if (!snap) {
      console.error(`turn ${targetTurn} 不存在（可选: ${snapshots.map((s) => s.turnIndex).join(', ')}）`);
      process.exit(1);
    }

    // 时间窗口：本 turn createdAt → 下一 turn createdAt（最后一 turn 取无穷大）
    const nextSnap = snapshots.find((s) => s.turnIndex === targetTurn + 1);
    const inWindow = (ts: number) => {
      if (ts < snap.createdAt) return false;
      if (nextSnap && ts >= nextSnap.createdAt) return false;
      return true;
    };

    const allMessages = db.getMessages(sessionId);
    const inTurnMessages = allMessages.filter((m) => inWindow(m.timestamp));
    // 工具调用从 messages 派生（assistant.toolCalls + 对应的 tool role 结果）
    const toolCalls: Array<{ toolName: string; success: boolean; createdAt: number }> = [];
    for (const m of inTurnMessages) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) {
          // 找对应的 tool role 消息（含 toolCallId 匹配的 result）
          const toolMsg = inTurnMessages.find(
            (x) => x.role === 'tool' && x.toolResults?.some((r) => r.toolCallId === tc.id),
          );
          const toolResult = toolMsg?.toolResults?.find((r) => r.toolCallId === tc.id);
          toolCalls.push({
            toolName: tc.name,
            success: toolResult?.success ?? false,
            createdAt: m.timestamp,
          });
        }
      }
    }

    if (options.json || process.argv.includes('--json')) {
      console.log(JSON.stringify({ snapshot: snap, inTurnMessages, toolCalls }, null, 2));
      return;
    }

    const ctx = snap.contextChunks as {
      systemPromptSize?: number;
      messageCount?: number;
      layers?: Array<{ name: string; size: number; snippet: string }>;
    } | null;
    const tok = snap.tokenBreakdown as {
      inputTokens?: number;
      outputTokens?: number;
      inferenceDurationMs?: number;
    } | null;

    console.log(`Turn ${snap.turnIndex} of ${sessionId}`);
    console.log(`  Snapshot ID:  ${snap.id}`);
    console.log(`  Turn ID:      ${snap.turnId ?? '-'}`);
    console.log(`  Created:      ${formatDate(snap.createdAt)}`);
    console.log(`  Snapshot 大小: ${formatBytes(snap.byteSize)}`);
    console.log('');
    console.log('Context (本 turn 输入给模型的):');
    console.log(`  System prompt: ${formatBytes(ctx?.systemPromptSize ?? 0)}`);
    console.log(`  Messages:      ${ctx?.messageCount ?? 0}`);
    console.log(`  本 turn 消耗:  ${tok?.inputTokens ?? 0} in → ${tok?.outputTokens ?? 0} out  (${tok?.inferenceDurationMs ?? 0}ms)`);
    console.log('');

    // 6 层上下文细分（identity + 已知 XML 块）
    if (ctx?.layers?.length) {
      console.log(`System prompt layers (${ctx.layers.length}):`);
      for (let i = 0; i < ctx.layers.length; i++) {
        const layer = ctx.layers[i]!;
        const sizeStr = layer.size < 1024 ? `${layer.size} B` : `${(layer.size / 1024).toFixed(1)} KB`;
        console.log(`  [${i}] ${layer.name.padEnd(22)} ${sizeStr.padStart(10)}`);
        if (layer.snippet) {
          const snippet = options.full ? layer.snippet : layer.snippet.slice(0, 100);
          console.log(`      | ${snippet}${layer.snippet.length > snippet.length ? '…' : ''}`);
        }
      }
      console.log('');
    }

    if (inTurnMessages.length > 0) {
      console.log(`Messages in this turn (${inTurnMessages.length}):`);
      for (const m of inTurnMessages) {
        const limit = options.full ? Infinity : 200;
        const content = typeof m.content === 'string' ? m.content : '';
        const preview = content.length > limit
          ? content.slice(0, limit) + ` … [+${content.length - limit} chars]`
          : content;
        const flags = [
          m.toolCalls?.length ? `tools=${m.toolCalls.length}` : null,
          m.toolResults?.length ? `results=${m.toolResults.length}` : null,
        ].filter(Boolean).join(' ');
        console.log(`  [${m.role.padEnd(9)}] ${formatDate(m.timestamp)}${flags ? `  (${flags})` : ''}`);
        if (preview) {
          for (const line of preview.split('\n')) {
            console.log(`    | ${line}`);
          }
        }
        if (m.toolCalls?.length) {
          for (const tc of m.toolCalls) {
            console.log(`    → tool_call: ${tc.name}`);
          }
        }
      }
      console.log('');
    } else {
      console.log('（本 turn 无新消息）');
      console.log('');
    }

    if (toolCalls.length > 0) {
      console.log(`Tool calls in this turn (${toolCalls.length}):`);
      for (const t of toolCalls) {
        const ok = t.success ? '✓' : '✗';
        console.log(`  ${ok} ${t.toolName.padEnd(20)}  ${formatDate(t.createdAt)}`);
      }
    } else {
      console.log('（本 turn 无工具调用）');
    }
  });

// ---------------------------------------------------------------------------
// loop trace <id> — 决策树
// ---------------------------------------------------------------------------

const loopTraceCommand = new Command('trace')
  .description('Agent loop 决策树（turn → 工具 → turn）')
  .argument('<sessionId>', 'session ID')
  .option('--json', 'JSON 格式输出')
  .action(async (sessionId: string, options: { json?: boolean }) => {
    const db = await initCLIDatabase();
    const snapshots = db.listTurnSnapshots(sessionId, 1000) as LooseSnapshot[];
    const allMessages = db.getMessages(sessionId);

    if (snapshots.length === 0) {
      console.error(`session ${sessionId} 没有 turn 快照`);
      process.exit(1);
    }

    interface ToolEntry { toolName: string; success: boolean; createdAt: number }
    interface TurnNode { snapshot: LooseSnapshot; tools: ToolEntry[] }
    const turns: TurnNode[] = snapshots.map((snap, i) => {
      const next = snapshots[i + 1];
      const inWindow = (ts: number) => ts >= snap.createdAt && (!next || ts < next.createdAt);
      const inTurn = allMessages.filter((m) => inWindow(m.timestamp));
      const tools: ToolEntry[] = [];
      for (const m of inTurn) {
        if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
        for (const tc of m.toolCalls) {
          const toolMsg = inTurn.find(
            (x) => x.role === 'tool' && x.toolResults?.some((r) => r.toolCallId === tc.id),
          );
          const toolResult = toolMsg?.toolResults?.find((r) => r.toolCallId === tc.id);
          tools.push({
            toolName: tc.name,
            success: toolResult?.success ?? false,
            createdAt: m.timestamp,
          });
        }
      }
      return { snapshot: snap, tools };
    });
    const totalTools = turns.reduce((sum, t) => sum + t.tools.length, 0);

    if (options.json || process.argv.includes('--json')) {
      console.log(JSON.stringify(turns, null, 2));
      return;
    }

    // 检测「卡死信号」：连续 3 turn 调用相同工具 / 工具结果空 / token 暴涨
    const stuckSignals: string[] = [];
    for (let i = 2; i < turns.length; i++) {
      const a = turns[i - 2]!.tools.map((t) => t.toolName).join(',');
      const b = turns[i - 1]!.tools.map((t) => t.toolName).join(',');
      const c = turns[i]!.tools.map((t) => t.toolName).join(',');
      if (a && a === b && b === c) {
        stuckSignals.push(`turn ${turns[i - 2]!.snapshot.turnIndex}-${turns[i]!.snapshot.turnIndex}: 连续 3 轮相同工具序列 [${a}]`);
      }
    }

    console.log(`Loop trace: ${sessionId}  (${turns.length} turns, ${totalTools} tool calls)`);
    console.log('');
    for (let i = 0; i < turns.length; i++) {
      const { snapshot: snap, tools } = turns[i]!;
      const tok = snap.tokenBreakdown as { inputTokens?: number; outputTokens?: number } | null;
      const ctx = snap.contextChunks as { messageCount?: number } | null;
      const isLast = i === turns.length - 1;
      const branch = isLast ? '└─' : '├─';
      const inner = isLast ? '   ' : '│  ';
      console.log(
        `${branch} Turn ${snap.turnIndex}  ${formatDate(snap.createdAt)}  ${tok?.inputTokens ?? 0}→${tok?.outputTokens ?? 0} tokens  ${ctx?.messageCount ?? 0} msgs`,
      );
      if (tools.length === 0) {
        console.log(`${inner} (no tool calls — text-only response)`);
      } else {
        for (let j = 0; j < tools.length; j++) {
          const t = tools[j]!;
          const tBranch = j === tools.length - 1 ? '└─' : '├─';
          const ok = t.success ? '✓' : '✗';
          console.log(`${inner} ${tBranch} ${ok} ${t.toolName}`);
        }
      }
    }

    if (stuckSignals.length > 0) {
      console.log('');
      console.log('⚠ 卡死信号:');
      for (const sig of stuckSignals) console.log(`  - ${sig}`);
    }
  });

const loopGroup = new Command('loop')
  .description('Agent loop 分析子命令')
  .addCommand(loopTraceCommand);

// ---------------------------------------------------------------------------
// compact diff <id> — 上下文压缩前后对比
// ---------------------------------------------------------------------------

const compactDiffCommand = new Command('diff')
  .description('显示某 session 的压缩历史与前后对比')
  .argument('<sessionId>', 'session ID')
  .option('--index <n>', '只看第 N 次压缩（1-based），默认显示全部摘要')
  .option('--json', 'JSON 格式输出')
  .action(async (sessionId: string, options: { index?: string; json?: boolean }) => {
    const db = await initCLIDatabase();
    const compactions = db.listCompactionSnapshots(sessionId, 1000);

    if (options.json || process.argv.includes('--json')) {
      if (options.index) {
        const i = parseInt(options.index, 10) - 1;
        console.log(JSON.stringify(compactions[i] ?? null, null, 2));
      } else {
        console.log(JSON.stringify(compactions, null, 2));
      }
      return;
    }

    if (compactions.length === 0) {
      console.log(`session ${sessionId} 没有压缩快照（说明本会话未触发过 autoCompressor）`);
      return;
    }

    if (options.index) {
      const idx = parseInt(options.index, 10) - 1;
      const c = compactions[idx];
      if (!c) {
        console.error(`第 ${options.index} 次压缩不存在（共 ${compactions.length} 次）`);
        process.exit(1);
      }

      const reduction = c.preTokens > 0 ? ((c.savedTokens / c.preTokens) * 100).toFixed(1) : '0';
      console.log(`Compaction #${idx + 1} of ${sessionId}`);
      console.log(`  Strategy:      ${c.strategy ?? '-'}`);
      console.log(`  Created:       ${formatDate(c.createdAt)}`);
      console.log(`  Usage 触发点:  ${c.usagePercent != null ? c.usagePercent.toFixed(1) + '%' : '-'}`);
      console.log(`  Messages:      ${c.preMessageCount} → ${c.postMessageCount}  (${c.postMessageCount - c.preMessageCount >= 0 ? '+' : ''}${c.postMessageCount - c.preMessageCount})`);
      console.log(`  Tokens:        ${c.preTokens} → ${c.postTokens}  (saved ${c.savedTokens}, -${reduction}%)`);
      console.log('');

      const pre = c.preMessagesSummary as Array<{ role: string; contentLength: number; hasToolCalls: boolean }> | null;
      const post = c.postMessagesSummary as Array<{ role: string; contentLength: number; hasToolCalls: boolean }> | null;
      if (!pre || !post) {
        console.log('（缺少消息摘要数据）');
        return;
      }

      console.log('Per-message diff (pre → post):');
      const maxLen = Math.max(pre.length, post.length);
      for (let i = 0; i < maxLen; i++) {
        const a = pre[i];
        const b = post[i];
        if (a && !b) {
          console.log(`  [${String(i).padStart(3)}] ✗ DROPPED  [${a.role.padEnd(9)}] ${a.contentLength} chars${a.hasToolCalls ? ' (tools)' : ''}`);
        } else if (!a && b) {
          console.log(`  [${String(i).padStart(3)}] + ADDED    [${b.role.padEnd(9)}] ${b.contentLength} chars${b.hasToolCalls ? ' (tools)' : ''}`);
        } else if (a && b) {
          if (a.contentLength === b.contentLength && a.role === b.role) {
            console.log(`  [${String(i).padStart(3)}] = KEPT     [${a.role.padEnd(9)}] ${a.contentLength} chars`);
          } else {
            const delta = b.contentLength - a.contentLength;
            console.log(`  [${String(i).padStart(3)}] ~ MODIFIED [${a.role.padEnd(9)}] ${a.contentLength} → ${b.contentLength} chars (${delta >= 0 ? '+' : ''}${delta})`);
          }
        }
      }
      return;
    }

    // 全部摘要
    console.log(`Compactions of ${sessionId} (${compactions.length} total):`);
    console.log('');
    console.log(`  ${pad('IDX', 4)}  ${pad('CREATED', 21)}  ${pad('STRATEGY', 14)}  ${pad('MSGS', 12)}  ${pad('TOKENS', 18, true)}  ${pad('SAVED %', 8, true)}`);
    console.log(`  ${'-'.repeat(4)}  ${'-'.repeat(21)}  ${'-'.repeat(14)}  ${'-'.repeat(12)}  ${'-'.repeat(18)}  ${'-'.repeat(8)}`);
    for (let i = 0; i < compactions.length; i++) {
      const c = compactions[i]!;
      const reduction = c.preTokens > 0 ? ((c.savedTokens / c.preTokens) * 100).toFixed(1) + '%' : '-';
      console.log(
        `  ${pad(i + 1, 4)}  ${pad(formatDate(c.createdAt), 21)}  ${pad(c.strategy ?? '-', 14)}  ${pad(`${c.preMessageCount}→${c.postMessageCount}`, 12)}  ${pad(`${c.preTokens}→${c.postTokens}`, 18, true)}  ${pad(reduction, 8, true)}`,
      );
    }
    console.log('');
    console.log(`提示: 用 --index N 看第 N 次压缩的逐条 diff`);
  });

const compactGroup = new Command('compact')
  .description('上下文压缩分析（diff）')
  .addCommand(compactDiffCommand);

// ---------------------------------------------------------------------------
// tool dry-run <name> — 直接调工具，不经过 agent loop
// （和顶层 exec-tool 等价；放在 debug 下方便从 debug 命令树发现）
// ---------------------------------------------------------------------------

const toolDryRunCommand = new Command('dry-run')
  .description('直接调用一个已注册工具（不经过 agent loop），等价于 code-agent exec-tool')
  .argument('<tool>', '工具名')
  .option('--params <json>', 'JSON object 格式的工具参数')
  .option('--params-file <path>', '从文件读取 JSON object 参数')
  .option('-s, --session <id>', '可选 session id')
  .action(async (tool: string, options: { params?: string; paramsFile?: string; session?: string }, command: Command) => {
    // command.parent 是 toolGroup, .parent 是 debugCommand, .parent 是 program
    const program = command.parent?.parent?.parent;
    const globalOpts = (program?.opts?.() ?? {}) as CLIGlobalOptions;
    await runToolDirectly(tool, options, globalOpts);
  });

const toolGroup = new Command('tool')
  .description('工具直接执行（不经过 agent loop）')
  .addCommand(toolDryRunCommand);

// ---------------------------------------------------------------------------
// replay <case-id> — 加载 YAML test case 并跑一遍
// ---------------------------------------------------------------------------

function runShellCommands(cmds: string[] | undefined, label: string): void {
  if (!cmds?.length) return;
  for (const cmd of cmds) {
    console.log(`[${label}] $ ${cmd}`);
    try {
      execSync(cmd, { stdio: 'inherit' });
    } catch (err) {
      console.warn(`[${label}] 命令失败（继续）: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const replayCommand = new Command('replay')
  .description('加载 YAML test case 并真跑一遍（用于复现某个 eval case 的 agent 行为）')
  .argument('[caseId]', '测试用例 ID（不传则配合 --list 用）')
  .option('--list', '列出所有可用的 case ID')
  .option('--filter <pattern>', '配合 --list：按 ID/description 子串过滤')
  .option('--dir <path>', '指定 test-cases 目录（默认 .claude/test-cases）')
  .option('--no-setup', '跳过 setup 命令')
  .option('--no-cleanup', '跳过 cleanup 命令')
  .option('--step', '每个 turn 完成后暂停等回车（仅 TTY 下生效）')
  .action(async (caseId: string | undefined, options: {
    list?: boolean;
    filter?: string;
    dir?: string;
    setup?: boolean;
    cleanup?: boolean;
    step?: boolean;
  }, command: Command) => {
    const program = command.parent?.parent;
    const globalOpts = (program?.opts?.() ?? {}) as CLIGlobalOptions;

    if (options.list) {
      const cases = loadAllReplayCases(options.dir);
      const filtered = options.filter
        ? cases.filter((c) =>
            c.id.includes(options.filter!) ||
            (c.description ?? '').includes(options.filter!),
          )
        : cases;
      if (filtered.length === 0) {
        console.log(`未找到 case（共扫描 ${cases.length} 条）`);
        return;
      }
      console.log(`Available cases (${filtered.length}/${cases.length}):`);
      console.log(`  ${pad('ID', 30)}  ${pad('TYPE', 14)}  ${pad('SUITE', 22)}  DESCRIPTION`);
      console.log(`  ${'-'.repeat(30)}  ${'-'.repeat(14)}  ${'-'.repeat(22)}  ${'-'.repeat(40)}`);
      for (const c of filtered) {
        console.log(`  ${pad(c.id, 30)}  ${pad(c.type ?? '-', 14)}  ${pad(c.suiteName, 22)}  ${(c.description ?? '').slice(0, 80)}`);
      }
      return;
    }

    if (!caseId) {
      console.error('用法: code-agent debug replay <caseId>，或 --list 看可用 case');
      process.exit(1);
    }

    const found: ReplayCase | null = findReplayCase(caseId, options.dir);
    if (!found) {
      console.error(`未找到 case: ${caseId}`);
      console.error('用 `code-agent debug replay --list` 查看可用 case ID');
      process.exit(1);
    }

    console.log(`Replaying case: ${found.id}`);
    console.log(`  Suite:        ${found.suiteName} (${found.suiteFile})`);
    console.log(`  Type:         ${found.type ?? '-'}`);
    console.log(`  Description:  ${found.description ?? '-'}`);
    console.log(`  Prompt:       ${found.prompt.slice(0, 120)}${found.prompt.length > 120 ? '…' : ''}`);
    if (found.follow_up_prompts?.length) {
      console.log(`  Follow-ups:   ${found.follow_up_prompts.length} 条`);
    }
    console.log('');

    if (options.step) {
      process.env.CODE_AGENT_STEP_MODE = 'true';
      console.log('[step] 已启用单步模式：每个 turn 完成后会暂停（输入 q 退出）');
      console.log('');
    }

    if (options.setup !== false) {
      runShellCommands(found.setup, 'setup');
    }

    // 跑 agent — 复用 createCLIAgent 路径（与 `code-agent run` 完全一致）
    const { createCLIAgent } = await import('../adapter');
    const { initializeCLIServices, cleanup } = await import('../bootstrap');
    await initializeCLIServices();

    const agent = await createCLIAgent({
      project: globalOpts.project,
      gen: globalOpts.gen,
      model: globalOpts.model,
      provider: globalOpts.provider,
      json: globalOpts.json,
      debug: globalOpts.debug,
      outputFormat: globalOpts.outputFormat,
      systemPrompt: globalOpts.systemPrompt,
      metrics: globalOpts.metrics,
    });

    let success = true;
    try {
      const prompts = [found.prompt, ...(found.follow_up_prompts ?? [])];
      for (let i = 0; i < prompts.length; i++) {
        if (i > 0) console.log(`\n── follow-up ${i} ──`);
        const result = await agent.run(prompts[i]!);
        if (!result.success) {
          success = false;
          console.error(`第 ${i + 1} 个 prompt 失败: ${result.error ?? 'unknown'}`);
          break;
        }
      }
    } catch (err) {
      success = false;
      console.error(`replay 失败: ${err instanceof Error ? err.message : String(err)}`);
    }

    const sessionId = agent.getSessionId?.() ?? null;
    if (options.cleanup !== false) {
      runShellCommands(found.cleanup, 'cleanup');
    }
    await cleanup();

    console.log('');
    console.log(`Replay ${success ? '完成' : '中止'}。Session ID: ${sessionId ?? '(no session created)'}`);
    if (sessionId) {
      console.log(`下一步：`);
      console.log(`  code-agent debug session ${sessionId}`);
      console.log(`  code-agent debug context ${sessionId}`);
      console.log(`  code-agent debug loop trace ${sessionId}`);
    }
    process.exit(success ? 0 : 1);
  });

// ---------------------------------------------------------------------------
// diff <sessionA> <sessionB> — 两 session 的 turn-by-turn 对比
// ---------------------------------------------------------------------------

interface DiffTurn {
  turnIndex: number;
  inputTokens: number;
  outputTokens: number;
  messageCount: number;
  toolNames: string[];
}

function buildDiffTurns(db: Awaited<ReturnType<typeof initCLIDatabase>>, sessionId: string): DiffTurn[] {
  const snaps = db.listTurnSnapshots(sessionId, 1000) as LooseSnapshot[];
  const allMessages = db.getMessages(sessionId);
  return snaps.map((snap, i) => {
    const next = snaps[i + 1];
    const inWindow = (ts: number) => ts >= snap.createdAt && (!next || ts < next.createdAt);
    const tools: string[] = [];
    for (const m of allMessages.filter((x) => inWindow(x.timestamp))) {
      if (m.role === 'assistant' && m.toolCalls?.length) {
        for (const tc of m.toolCalls) tools.push(tc.name);
      }
    }
    const tok = snap.tokenBreakdown as { inputTokens?: number; outputTokens?: number } | null;
    const ctx = snap.contextChunks as { messageCount?: number } | null;
    return {
      turnIndex: snap.turnIndex,
      inputTokens: tok?.inputTokens ?? 0,
      outputTokens: tok?.outputTokens ?? 0,
      messageCount: ctx?.messageCount ?? 0,
      toolNames: tools,
    };
  });
}

const diffCommand = new Command('diff')
  .description('两个 session 的 turn-by-turn 对比（用于回归定位）')
  .argument('<sessionA>', '基线 session ID')
  .argument('<sessionB>', '对比 session ID')
  .option('--json', 'JSON 格式输出')
  .action(async (sessionA: string, sessionB: string, options: { json?: boolean }) => {
    const db = await initCLIDatabase();
    const a = buildDiffTurns(db, sessionA);
    const b = buildDiffTurns(db, sessionB);

    if (options.json || process.argv.includes('--json')) {
      console.log(JSON.stringify({ sessionA, sessionB, a, b }, null, 2));
      return;
    }

    if (a.length === 0) {
      console.error(`session ${sessionA} 没有快照`);
      process.exit(1);
    }
    if (b.length === 0) {
      console.error(`session ${sessionB} 没有快照`);
      process.exit(1);
    }

    console.log(`Session diff: ${sessionA}  vs  ${sessionB}`);
    console.log(`  Turns:  ${a.length} vs ${b.length}${a.length !== b.length ? '  (∆)' : ''}`);
    const sumA = a.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
    const sumB = b.reduce((s, t) => s + t.inputTokens + t.outputTokens, 0);
    console.log(`  Tokens: ${sumA} vs ${sumB}  (${sumB - sumA >= 0 ? '+' : ''}${sumB - sumA})`);
    const toolsA = a.flatMap((t) => t.toolNames);
    const toolsB = b.flatMap((t) => t.toolNames);
    console.log(`  Tools:  ${toolsA.length} 次 vs ${toolsB.length} 次`);
    console.log('');

    console.log('Per-turn:');
    console.log(`  ${pad('TURN', 6)}  ${pad('A: tokens / msgs / tools', 38)}  ${pad('B: tokens / msgs / tools', 38)}  DIFF`);
    console.log(`  ${'-'.repeat(6)}  ${'-'.repeat(38)}  ${'-'.repeat(38)}  ----`);
    const maxLen = Math.max(a.length, b.length);
    for (let i = 0; i < maxLen; i++) {
      const ta = a[i];
      const tb = b[i];
      const fmtTurn = (t: DiffTurn | undefined) =>
        t ? `${t.inputTokens}→${t.outputTokens} / ${t.messageCount}m / [${t.toolNames.join(',')}]` : '—';
      let marker = '=';
      if (ta && !tb) marker = '✗ A only';
      else if (!ta && tb) marker = '+ B only';
      else if (ta && tb) {
        const diffs: string[] = [];
        if (ta.inputTokens !== tb.inputTokens) diffs.push(`in${tb.inputTokens - ta.inputTokens >= 0 ? '+' : ''}${tb.inputTokens - ta.inputTokens}`);
        if (ta.outputTokens !== tb.outputTokens) diffs.push(`out${tb.outputTokens - ta.outputTokens >= 0 ? '+' : ''}${tb.outputTokens - ta.outputTokens}`);
        if (ta.toolNames.join(',') !== tb.toolNames.join(',')) diffs.push('tools');
        if (ta.messageCount !== tb.messageCount) diffs.push(`msgs${tb.messageCount - ta.messageCount >= 0 ? '+' : ''}${tb.messageCount - ta.messageCount}`);
        marker = diffs.length === 0 ? '=' : `~ ${diffs.join(' ')}`;
      }
      console.log(`  ${pad(i + 1, 6)}  ${pad(fmtTurn(ta), 38)}  ${pad(fmtTurn(tb), 38)}  ${marker}`);
    }
  });

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

export const debugCommand = new Command('debug')
  .description('调试快照、回放、决策树与压缩对比')
  .addCommand(statsCommand)
  .addCommand(clearCommand)
  .addCommand(sessionCommand)
  .addCommand(contextCommand)
  .addCommand(loopGroup)
  .addCommand(compactGroup)
  .addCommand(toolGroup)
  .addCommand(replayCommand)
  .addCommand(diffCommand);
