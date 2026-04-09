// ============================================================================
// Smoke test for v2.5 Phase 2 — Trajectory Failure Attribution
//
// Reads the most recent sessions from the local code-agent DB, builds a
// trajectory for each, runs the full attribution pipeline, and prints a
// human-readable report. No DB writes.
//
// Usage: npx tsx scripts/smoke-attribution.ts [--limit N] [--sessionId ID]
// ============================================================================

import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as os from 'node:os';
import { TrajectoryBuilder } from '../src/main/evaluation/trajectory/trajectoryBuilder';
import { DeviationDetector } from '../src/main/evaluation/trajectory/deviationDetector';
import { FailureAttributor } from '../src/main/evaluation/trajectory/attribution';

interface EventRow {
  session_id: string;
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

function parseArgs(): { limit: number; sessionId?: string } {
  const argv = process.argv.slice(2);
  let limit = 5;
  let sessionId: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--limit' && argv[i + 1]) {
      limit = parseInt(argv[++i], 10);
    } else if (argv[i] === '--sessionId' && argv[i + 1]) {
      sessionId = argv[++i];
    }
  }
  return { limit, sessionId };
}

function main() {
  const dbPath = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'code-agent',
    'code-agent.db'
  );
  const db = new Database(dbPath, { readonly: true });

  const { limit, sessionId } = parseArgs();

  // Pick target sessions: either a specific id, or the most recent N with
  // enough events to build a meaningful trajectory.
  let sessions: SessionRow[];
  if (sessionId) {
    const row = db
      .prepare<
        [string],
        SessionRow
      >(
        `SELECT session_id, COUNT(*) as event_count,
                MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
         FROM session_events
         WHERE session_id = ?
         GROUP BY session_id`
      )
      .get(sessionId);
    sessions = row ? [row] : [];
  } else {
    sessions = db
      .prepare<
        [number],
        SessionRow
      >(
        `SELECT session_id, COUNT(*) as event_count,
                MIN(timestamp) as first_ts, MAX(timestamp) as last_ts
         FROM session_events
         GROUP BY session_id
         HAVING event_count >= 5
         ORDER BY last_ts DESC
         LIMIT ?`
      )
      .all(limit);
  }

  if (sessions.length === 0) {
    console.log('No sessions found. Try `--sessionId <id>` or check the DB.');
    return;
  }

  console.log(
    `\n=== v2.5 Phase 2 Smoke — Trajectory Failure Attribution ===\n`
  );
  console.log(`DB: ${dbPath}`);
  console.log(`Sessions to analyze: ${sessions.length}\n`);

  const eventsStmt = db.prepare<[string], EventRow>(
    `SELECT session_id, event_type, event_data, timestamp
     FROM session_events
     WHERE session_id = ?
     ORDER BY timestamp ASC`
  );

  const builder = new TrajectoryBuilder();
  const detector = new DeviationDetector();
  const attributor = new FailureAttributor();

  (async () => {
    for (const s of sessions) {
      const rows = eventsStmt.all(s.session_id);
      const events = rows.map((r) => ({
        event_type: r.event_type,
        event_data: safeParse(r.event_data),
        timestamp: String(r.timestamp),
      }));

      const trajectory = builder.buildFromEvents(events);
      trajectory.sessionId = s.session_id;
      trajectory.deviations = detector.detectByRules(trajectory);

      const attribution = await attributor.attribute(trajectory, {
        enableLLM: false,
      });

      const shortId = s.session_id.split('_').slice(-1)[0];
      const durationSec = ((s.last_ts - s.first_ts) / 1000).toFixed(1);
      console.log(
        `── session ${shortId} | events=${s.event_count} | ${durationSec}s`
      );
      console.log(
        `  trajectory: ${trajectory.steps.length} steps | outcome=${trajectory.summary.outcome} | deviations=${trajectory.deviations.length}`
      );
      if (attribution.rootCause) {
        console.log(
          `  rootCause: [${attribution.rootCause.category}] conf=${attribution.rootCause.confidence.toFixed(
            2
          )} @ step ${attribution.rootCause.stepIndex}`
        );
        console.log(`  summary: ${attribution.rootCause.summary.slice(0, 120)}`);
      } else {
        console.log(`  rootCause: (none — trajectory succeeded)`);
      }
      console.log(
        `  causalChain: ${attribution.causalChain.length} node(s) | llmUsed=${attribution.llmUsed} | durMs=${attribution.durationMs}`
      );
      if (attribution.relatedRegressionCases.length > 0) {
        console.log(
          `  relatedRegressionCases: ${attribution.relatedRegressionCases.join(', ')}`
        );
      }
      console.log();
    }

    db.close();
  })();
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s);
  } catch {
    return {};
  }
}

main();
