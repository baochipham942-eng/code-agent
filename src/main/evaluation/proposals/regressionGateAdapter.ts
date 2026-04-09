// ============================================================================
// Regression Gate Adapter — Self-Evolving v2.5 Phase 3
//
// Thin wrapper around v2.4's `npm run regression:gate` CLI. Returns a
// tri-state decision; any execution error is normalized to 'skipped' so
// shadow evaluation can still proceed on a best-effort basis.
// ============================================================================

import { spawnSync } from 'node:child_process';
import * as path from 'node:path';
import * as os from 'node:os';

export interface RegressionGateOptions {
  cwd?: string;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function defaultCodeAgentDir(): string {
  return path.join(os.homedir(), 'Downloads', 'ai', 'code-agent');
}

export async function runRegressionGateViaCli(
  opts: RegressionGateOptions = {}
): Promise<'pass' | 'block' | 'skipped'> {
  const cwd = opts.cwd ?? defaultCodeAgentDir();
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let result;
  try {
    result = spawnSync('npm', ['run', '--silent', 'regression:gate'], {
      cwd,
      timeout,
      encoding: 'utf8',
    });
  } catch {
    return 'skipped';
  }

  if (result.error || result.signal) return 'skipped';
  if (result.status === null) return 'skipped';

  // The gate CLI prints a JSON object shaped as:
  //   { report: {...}, decision: { decision: "pass"|"block", ... } }
  // See src/cli/regression-cli.ts (v2.4). The JSON may be preceded or
  // followed by npm/shell noise, so extract the first top-level object.
  const stdout = result.stdout ?? '';
  const jsonText = extractTopLevelJson(stdout);
  if (!jsonText) return 'skipped';

  try {
    const parsed = JSON.parse(jsonText) as { decision?: { decision?: string } };
    const inner = parsed?.decision?.decision;
    if (inner === 'pass') return 'pass';
    if (inner === 'block') return 'block';
  } catch {
    // fall through
  }

  return 'skipped';
}

function extractTopLevelJson(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escape) {
        escape = false;
      } else if (ch === '\\') {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}
