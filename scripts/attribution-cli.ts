// ============================================================================
// Attribution CLI — Self-Evolving v2.5 Phase 2.1
//
// Extracts a structured `failure_attribution` object for a given session_id
// by reading events from the local code-agent DB, building a Trajectory,
// running DeviationDetector + FailureAttributor, and printing the result as
// JSON ready to embed in a grader report (schema v2.2).
//
// Commands:
//   attribution show <sessionId>            — print full Attribution JSON
//   attribution grader <sessionId>          — print the v2.2 grader embed shape
//   attribution list [--limit N]            — list recent failing sessions + category
//
// Usage: npx tsx scripts/attribution-cli.ts <command> [...]
// ============================================================================

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrajectoryBuilder } from '../src/main/evaluation/trajectory/trajectoryBuilder';
import { DeviationDetector } from '../src/main/evaluation/trajectory/deviationDetector';
import { FailureAttributor } from '../src/main/evaluation/trajectory/attribution';
import { buildAttributionChatFnFromEnv } from '../src/main/evaluation/llmChatFactory';
import type { FailureAttribution } from '../src/main/testing/types';

interface EventRow {
  event_type: string;
  event_data: string;
  timestamp: number;
}

interface SessionRow {
  session_id: string;
  event_count: number;
  first_ts: number;
  last_ts: number;
}

function dbPath(): string {
  return path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'code-agent',
    'code-agent.db'
  );
}

function openDb(): Database.Database {
  return new Database(dbPath(), { readonly: true });
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

async function buildAttribution(
  db: Database.Database,
  sessionId: string
): Promise<FailureAttribution | null> {
  const rows = db
    .prepare<[string], EventRow>(
      `SELECT event_type, event_data, timestamp
       FROM session_events
       WHERE session_id = ?
       ORDER BY timestamp ASC`
    )
    .all(sessionId);

  if (rows.length === 0) return null;

  const events = rows.map((r) => ({
    event_type: r.event_type,
    event_data: safeParse(r.event_data),
    timestamp: String(r.timestamp),
  }));

  const builder = new TrajectoryBuilder();
  const trajectory = builder.buildFromEvents(events);
  trajectory.sessionId = sessionId;
  const detector = new DeviationDetector();
  trajectory.deviations = detector.detectByRules(trajectory);

  // Phase 7 (A): honor CODE_AGENT_EVAL_LLM_ENABLED for LLM fallback.
  // When the env flag is off (default), this stays rule-only.
  const llmFn = await buildAttributionChatFnFromEnv();
  const attributor = new FailureAttributor();
  return attributor.attribute(trajectory, {
    enableLLM: llmFn !== null,
    llmFn: llmFn ?? undefined,
  });
}

function toGraderEmbed(attr: FailureAttribution): Record<string, unknown> {
  // Schema v2.2 embed shape (mirrors what ~/.claude/skills/grader/SKILL.md
  // declares under failure_attribution).
  return {
    root_cause_category: attr.rootCause?.category ?? 'unknown',
    root_cause_summary: attr.rootCause?.summary ?? '',
    root_cause_step_index: attr.rootCause?.stepIndex ?? 0,
    confidence: attr.rootCause?.confidence ?? 0,
    related_regression_cases: attr.relatedRegressionCases,
    llm_used: attr.llmUsed,
    causal_chain_length: attr.causalChain.length,
  };
}

async function cmdShow(sessionId: string) {
  const db = openDb();
  try {
    const attr = await buildAttribution(db, sessionId);
    if (!attr) {
      console.error(`No events found for session ${sessionId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(attr, null, 2));
  } finally {
    db.close();
  }
}

async function cmdGrader(sessionId: string) {
  const db = openDb();
  try {
    const attr = await buildAttribution(db, sessionId);
    if (!attr) {
      console.error(`No events found for session ${sessionId}`);
      process.exit(1);
    }
    console.log(JSON.stringify(toGraderEmbed(attr), null, 2));
  } finally {
    db.close();
  }
}

async function cmdList(limit: number) {
  const db = openDb();
  try {
    const sessions = db
      .prepare<[number], SessionRow>(
        `SELECT session_id, COUNT(*) as event_count,
                MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
         FROM session_events
         GROUP BY session_id
         HAVING event_count >= 5
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);

    const out: Array<{
      sessionId: string;
      outcome: string;
      rootCause: string | null;
      confidence: number | null;
    }> = [];

    for (const s of sessions) {
      const attr = await buildAttribution(db, s.session_id);
      if (!attr) continue;
      out.push({
        sessionId: s.session_id,
        outcome: attr.outcome,
        rootCause: attr.rootCause?.category ?? null,
        confidence: attr.rootCause?.confidence ?? null,
      });
    }

    console.log(JSON.stringify(out, null, 2));
  } finally {
    db.close();
  }
}

function parseArgs(): { cmd: string; sessionId?: string; limit: number } {
  const [, , cmd = 'list', ...rest] = process.argv;
  const out: { cmd: string; sessionId?: string; limit: number } = {
    cmd,
    limit: 10,
  };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--limit' && rest[i + 1]) {
      out.limit = parseInt(rest[++i], 10);
    } else if (!a.startsWith('--') && !out.sessionId) {
      out.sessionId = a;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  switch (args.cmd) {
    case 'show':
      if (!args.sessionId) throw new Error('attribution show <sessionId>');
      await cmdShow(args.sessionId);
      break;
    case 'grader':
      if (!args.sessionId) throw new Error('attribution grader <sessionId>');
      await cmdGrader(args.sessionId);
      break;
    case 'list':
      await cmdList(args.limit);
      break;
    default:
      console.error(
        `Unknown command: ${args.cmd}\nUsage: attribution [show|grader|list] [sessionId] [--limit N]`
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Error: ${err?.message ?? err}`);
  process.exit(1);
});
