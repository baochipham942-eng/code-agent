#!/usr/bin/env node
/**
 * Replay read/write tool-call sequences and report, per session, the
 * consecutive read-only rounds and calls at the moment the pre-change
 * per-call guard (15) would fire.
 *
 * Recorded sessions: pass --db <sqlite> --metrics <patrol metrics dir>.
 * The database is read-only. Output is case ids and counts only.
 * Without those flags, replays the unit-test shapes plus synthetic rounds.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CURRENT_CALL_GUARD = 15;
const ROUND_HARD_LIMIT = 15;
const READ_ONLY = new Set([
  'read_file', 'Read', 'glob', 'Glob', 'grep', 'Grep', 'list_directory',
  'web_fetch', 'WebFetch', 'web_search', 'WebSearch',
]);
const WRITE = new Set(['write_file', 'Write', 'append_file', 'Append', 'edit_file', 'Edit']);
const PARALLEL_SAFE = new Set([
  'Read', 'Glob', 'Grep', 'ListDirectory', 'web_fetch', 'WebFetch', 'WebSearch',
  'memory_search', 'Explore', 'Task',
]);
const SHELL_FILE_READ_PATTERN =
  /\b(cat|less|more|head|tail|sed|awk|nl|bat|grep|rg|find|ls|wc)\b|\bpython3?\b[\s\S]*\b(open|read_text|readlines|Path\()/i;
const SHELL_MUTATION_PATTERN =
  /\b(rm|mv|cp|mkdir|touch|chmod|chown|tee)\b|\bsed\s+-i\b|\bfind\b[\s\S]*\s-delete\b|(?:^|[;&|]\s*)echo\b[\s\S]*(?:>|>>)|\bpython3?\b[\s\S]*\b(write_text|write_bytes|write\(|append\()/i;

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function isReadOnlyShell(command) {
  return SHELL_FILE_READ_PATTERN.test(command) && !SHELL_MUTATION_PATTERN.test(command);
}

function classify(name, command) {
  if (WRITE.has(name)) return 'write';
  if (READ_ONLY.has(name)) return 'read';
  if (name === 'Bash' || name === 'bash') {
    return command && isReadOnlyShell(command) ? 'read' : 'other';
  }
  return 'other';
}

function executionOrder(calls) {
  const parallel = [];
  const sequential = [];
  let crossedWriteBoundary = false;
  for (const call of calls) {
    const safe = PARALLEL_SAFE.has(call.name);
    const writeCapable = call.name === 'Task';
    if (safe && (writeCapable || !crossedWriteBoundary)) parallel.push(call);
    else sequential.push(call);
    if (writeCapable || !safe) crossedWriteBoundary = true;
  }
  return [...parallel, ...sequential];
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function replayOldGuard(rounds) {
  let calls = 0;
  let readRounds = 0;
  for (let index = 0; index < rounds.length; index += 1) {
    let countedRound = false;
    for (const call of rounds[index]) {
      if (call.kind === 'write' && call.success) {
        calls = 0;
        readRounds = 0;
        countedRound = false;
        continue;
      }
      if (call.kind !== 'read') continue;
      if (!countedRound) {
        readRounds += 1;
        countedRound = true;
      }
      calls += 1;
      if (calls >= CURRENT_CALL_GUARD) {
        return { fired: true, rounds: readRounds, calls, sourceRound: index + 1 };
      }
    }
  }
  return { fired: false, rounds: readRounds, calls, sourceRound: null };
}

function maxNewStreak(rounds) {
  let readRounds = 0;
  let calls = 0;
  let maxRounds = 0;
  let maxCalls = 0;
  const finish = (sawRead, sawWrite) => {
    if (sawWrite) {
      readRounds = 0;
      calls = 0;
      return;
    }
    if (sawRead) readRounds += 1;
    maxRounds = Math.max(maxRounds, readRounds);
    maxCalls = Math.max(maxCalls, calls);
  };
  for (const round of rounds) {
    let sawRead = false;
    let sawWrite = false;
    for (const call of round) {
      if (call.kind === 'write' && call.success) {
        finish(sawRead, false);
        readRounds = 0;
        calls = 0;
        sawRead = false;
        sawWrite = true;
        continue;
      }
      if (call.kind !== 'read') continue;
      calls += 1;
      maxCalls = Math.max(maxCalls, calls);
      sawRead = true;
    }
    finish(sawRead, sawWrite);
  }
  return { maxRounds, maxCalls };
}

function wouldTripNewGuard(rounds, backstop) {
  let readRounds = 0;
  let calls = 0;
  for (const round of rounds) {
    let sawRead = false;
    let sawWrite = false;
    for (const call of round) {
      if (call.kind === 'write' && call.success) {
        readRounds = 0;
        calls = 0;
        sawRead = false;
        sawWrite = true;
        continue;
      }
      if (call.kind !== 'read') continue;
      calls += 1;
      if (calls >= backstop) return 'calls';
      if (!sawRead && readRounds + 1 >= ROUND_HARD_LIMIT) return 'rounds';
      sawRead = true;
    }
    if (sawWrite) {
      readRounds = 0;
      calls = 0;
    } else if (sawRead) {
      readRounds += 1;
    }
  }
  return null;
}

function loadCaseIndex(metricsDir) {
  const grouped = new Map();
  for (const name of readdirSync(metricsDir)) {
    if (!name.endsWith('.json')) continue;
    const metrics = JSON.parse(readFileSync(join(metricsDir, name), 'utf8'));
    if (!metrics.sessionId) continue;
    const stem = basename(name, '.json');
    const attemptMatch = stem.match(/-(\d+)$/);
    const errors = Array.isArray(metrics.errors) ? metrics.errors : [];
    const guardHits = errors.filter((error) => String(error?.message || '').includes('连续只读操作达到硬阈值')).length;
    const entry = {
      caseId: attemptMatch ? stem.slice(0, -attemptMatch[0].length) : stem,
      attempt: attemptMatch ? Number(attemptMatch[1]) : 0,
      guardHits,
      toolCallCount: Number(metrics.toolCallCount) || 0,
    };
    const list = grouped.get(metrics.sessionId) || [];
    list.push(entry);
    grouped.set(metrics.sessionId, list);
  }
  const index = new Map();
  for (const [sessionId, entries] of grouped) {
    entries.sort((a, b) => b.guardHits - a.guardHits || b.toolCallCount - a.toolCallCount || a.attempt - b.attempt);
    index.set(sessionId, entries[0]);
  }
  return index;
}

function loadSessions(dbPath, sessionIds) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const ids = [...sessionIds];
  const placeholders = ids.map(() => '?').join(',');
  const callRows = db.prepare(`
    SELECT m.session_id, m.timestamp, m.id AS message_id,
           CAST(j.key AS INTEGER) AS ord,
           json_extract(j.value, '$.id') AS call_id,
           json_extract(j.value, '$.name') AS name,
           json_extract(j.value, '$.arguments.command') AS command
    FROM messages m, json_each(m.tool_calls) j
    WHERE m.role = 'assistant'
      AND json_valid(m.tool_calls)
      AND m.session_id IN (${placeholders})
    ORDER BY m.session_id, m.timestamp, ord
  `).all(...ids);
  const resultRows = db.prepare(`
    SELECT json_extract(j.value, '$.toolCallId') AS call_id,
           json_extract(j.value, '$.success') AS success
    FROM messages m, json_each(m.tool_results) j
    WHERE json_valid(m.tool_results)
      AND m.session_id IN (${placeholders})
  `).all(...ids);
  db.close();

  const successByCall = new Map();
  for (const row of resultRows) {
    if (!row.call_id || successByCall.has(row.call_id)) continue;
    successByCall.set(row.call_id, row.success === 1 || row.success === true);
  }

  const sessions = new Map();
  for (const row of callRows) {
    let session = sessions.get(row.session_id);
    if (!session) {
      session = [];
      sessions.set(row.session_id, session);
    }
    let round = session[session.length - 1];
    if (!round || round.messageId !== row.message_id) {
      round = { messageId: row.message_id, calls: [] };
      session.push(round);
    }
    round.calls.push({
      name: row.name,
      command: row.command || '',
      kind: classify(row.name, row.command || ''),
      success: successByCall.get(row.call_id) === true,
    });
  }

  for (const rounds of sessions.values()) {
    for (const round of rounds) round.calls = executionOrder(round.calls);
  }
  return sessions;
}

function measureRecorded(dbPath, metricsDir) {
  const caseIndex = loadCaseIndex(metricsDir);
  const sessions = loadSessions(dbPath, caseIndex.keys());
  const rows = [];
  let scanned = 0;
  let bashReads = 0;
  let bashOther = 0;
  const roundSizes = [];
  for (const [sessionId, rounds] of sessions) {
    scanned += 1;
    const ordered = rounds.map((round) => round.calls);
    for (const round of ordered) {
      const reads = round.filter((call) => call.kind === 'read').length;
      if (reads > 0) roundSizes.push(reads);
      for (const call of round) {
        if (call.name !== 'Bash' && call.name !== 'bash') continue;
        if (call.kind === 'read') bashReads += 1;
        else bashOther += 1;
      }
    }
    const fired = replayOldGuard(ordered);
    if (!fired.fired) continue;
    const meta = caseIndex.get(sessionId);
    const streak = maxNewStreak(ordered);
    rows.push({
      caseId: meta?.caseId ?? 'unmapped',
      attempt: meta?.attempt ?? 0,
      guardHits: meta?.guardHits ?? 0,
      rounds: fired.rounds,
      calls: fired.calls,
      sourceRound: fired.sourceRound,
      maxRounds: streak.maxRounds,
      maxCalls: streak.maxCalls,
      new40: wouldTripNewGuard(ordered, 40),
      new60: wouldTripNewGuard(ordered, 60),
    });
  }
  rows.sort((a, b) => a.caseId.localeCompare(b.caseId) || a.attempt - b.attempt || a.sourceRound - b.sourceRound);
  const recorded = rows.filter((row) => row.guardHits > 0);
  const roundValues = recorded.map((row) => row.rounds).sort((a, b) => a - b);
  const flows = recorded.filter((row) => row.caseId.startsWith('fl-'));
  console.log(`source=patrol-metrics+messages; sessions_scanned=${scanned}; guard=15_consecutive_read_only_calls`);
  console.log('case | attempt | metrics_guard_events | consecutive_read_only_rounds_at_guard | consecutive_read_only_calls_at_guard | source_round | full_trace_max_rounds | full_trace_max_calls | still_trips_round15_or_backstop40 | still_trips_round15_or_backstop60');
  for (const row of recorded) {
    console.log(`${row.caseId} | ${row.attempt} | ${row.guardHits} | ${row.rounds} | ${row.calls} | ${row.sourceRound} | ${row.maxRounds} | ${row.maxCalls} | ${row.new40 ?? 'no'} | ${row.new60 ?? 'no'}`);
  }
  const replayOnly = rows.filter((row) => row.guardHits === 0).map((row) => `${row.caseId}#${row.attempt}`);
  console.log(`replay_only_not_in_metrics=${replayOnly.join(',') || 'none'}`);
  console.log(`replay_firing_sessions=${rows.length} metrics_matched_sessions=${recorded.length} replay_only=${rows.length - recorded.length}`);
  console.log(`rounds_at_fire min=${roundValues[0] ?? 'n/a'} p50=${percentile(roundValues, 50) ?? 'n/a'} p90=${percentile(roundValues, 90) ?? 'n/a'} max=${roundValues[roundValues.length - 1] ?? 'n/a'}`);
  console.log(`flows_firing=${flows.length} flows_still_trip_at_40=${flows.filter((row) => row.new40).length} flows_still_trip_at_60=${flows.filter((row) => row.new60).length}`);
  const sizes = [...roundSizes].sort((a, b) => a - b);
  console.log(`read_calls_per_read_round max=${sizes[sizes.length - 1] ?? 0} p90=${percentile(sizes, 90) ?? 0} p50=${percentile(sizes, 50) ?? 0}`);
  console.log(`bash_classified read_only=${bashReads} other=${bashOther}`);
  console.log('chosen_backstop=40 consecutive read-only calls');
}

function measureSynthetic() {
  const sessions = [
    { name: 'unit-sequential-15', rounds: Array.from({ length: 15 }, () => ({ reads: 1 })) },
    { name: 'unit-parallel-3x5', rounds: Array.from({ length: 3 }, () => ({ reads: 5 })) },
    { name: 'synthetic-parallel-8x5', rounds: Array.from({ length: 5 }, () => ({ reads: 8 })) },
    { name: 'synthetic-mixed-write-reset', rounds: [
      { reads: 4 }, { reads: 4 }, { reads: 2, write: true },
      { reads: 8 }, { reads: 8 }, { reads: 8 },
    ] },
    { name: 'synthetic-sequential-after-write', rounds: [
      { reads: 1 }, { reads: 1 }, { reads: 1 }, { reads: 1 }, { reads: 1 },
      { reads: 1, write: true },
      ...Array.from({ length: 15 }, () => ({ reads: 1 })),
    ] },
    { name: 'synthetic-parallel-heavy-62pct', rounds: [
      { reads: 5 }, { reads: 5 }, { reads: 5 }, { reads: 2 },
      { reads: 8 }, { reads: 8 }, { reads: 8 }, { reads: 8 }, { reads: 8 },
    ] },
  ];
  console.log('source=unit-test-shapes+synthetic; current_guard=15_consecutive_read_only_calls');
  console.log('session | consecutive_read_only_rounds_at_guard | consecutive_read_only_calls_at_guard');
  for (const session of sessions) {
    const rounds = session.rounds.map((round) => {
      const calls = Array.from({ length: round.reads }, () => ({ kind: 'read', success: true, name: 'Read' }));
      if (round.write) calls.push({ kind: 'write', success: true, name: 'Write' });
      return calls;
    });
    const result = replayOldGuard(rounds);
    console.log(`${session.name} | ${result.rounds} | ${result.calls}${result.sourceRound ? ` (source round ${result.sourceRound})` : ''}`);
  }
  console.log('chosen_backstop=40 consecutive read-only calls');
}

const dbPath = argValue('--db');
const metricsDir = argValue('--metrics');
if (dbPath && metricsDir) measureRecorded(dbPath, metricsDir);
else measureSynthetic();
