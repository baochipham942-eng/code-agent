#!/usr/bin/env node
// ============================================================================
// Agent Neo production error log inspector
// ============================================================================
// Read-only helper for the common "what broke in the last N hours?" pass:
// - Supabase linked project telemetry tables via `supabase db query --linked`
// - Vercel production request/runtime logs via `vercel logs`
//
// The script intentionally reports aggregates and short excerpts only. It does
// not dump full prompts/completions, bearer tokens, or service-role credentials.
// ============================================================================

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');

const DEFAULTS = {
  since: '48h',
  environment: 'production',
  project: 'code-agent',
  limit: 200,
  spikeThreshold: 1_000,
};

class NeoLogInspectorError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'NeoLogInspectorError';
    this.code = options.code ?? 'neo_log_inspector_failed';
    this.details = options.details;
  }
}

function usage() {
  return `
Usage:
  node scripts/inspect-neo-logs.mjs [options]
  npm run ops:neo-errors -- [options]

Options:
  --since <window|iso>        Start of window. Default: ${DEFAULTS.since}
                              Examples: 2d, 48h, 90m, 2026-07-06T15:00:00Z
  --until <window|iso>        End of window. Default: now
  --project <name>            Vercel project. Default: ${DEFAULTS.project}
  --environment <env>         Vercel environment. Default: ${DEFAULTS.environment}
  --limit <n>                 Max Vercel log rows per query. Default: ${DEFAULTS.limit}
  --spike-threshold <n>       cloud_config requests/hour alert threshold. Default: ${DEFAULTS.spikeThreshold}
  --skip-supabase             Skip Supabase telemetry/control-plane queries
  --skip-vercel               Skip Vercel runtime/request log queries
  --json                      Print machine-readable JSON
  --help                      Show this help
`.trim();
}

function parseArgs(argv) {
  const args = {
    ...DEFAULTS,
    skipSupabase: false,
    skipVercel: false,
    json: false,
    help: false,
    until: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    const readValue = (name) => {
      const value = argv[i + 1];
      if (!value || value.startsWith('--')) {
        throw new NeoLogInspectorError(`${name} requires a value`, { code: 'invalid_args' });
      }
      i += 1;
      return value;
    };

    if (token === '--help' || token === '-h') args.help = true;
    else if (token === '--json') args.json = true;
    else if (token === '--skip-supabase') args.skipSupabase = true;
    else if (token === '--skip-vercel') args.skipVercel = true;
    else if (token === '--since') args.since = readValue(token);
    else if (token === '--until') args.until = readValue(token);
    else if (token === '--project') args.project = readValue(token);
    else if (token === '--environment') args.environment = readValue(token);
    else if (token === '--limit') args.limit = assertPositiveInt(readValue(token), token);
    else if (token === '--spike-threshold') args.spikeThreshold = assertPositiveInt(readValue(token), token);
    else {
      throw new NeoLogInspectorError(`Unknown option: ${token}`, { code: 'invalid_args' });
    }
  }

  if (args.skipSupabase && args.skipVercel) {
    throw new NeoLogInspectorError('At least one source must be enabled.', { code: 'invalid_args' });
  }

  return args;
}

function assertPositiveInt(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new NeoLogInspectorError(`${label} must be a positive integer`, {
      code: 'invalid_args',
      details: { value },
    });
  }
  return parsed;
}

function parseTimeArg(value, relativeTo) {
  if (!value || value === 'now') return new Date();
  const relative = /^(\d+)(ms|s|m|h|d)$/i.exec(value.trim());
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multipliers = {
      ms: 1,
      s: 1_000,
      m: 60_000,
      h: 60 * 60_000,
      d: 24 * 60 * 60_000,
    };
    return new Date(relativeTo.getTime() - amount * multipliers[unit]);
  }

  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new NeoLogInspectorError(`Invalid time value: ${value}`, { code: 'invalid_time' });
  }
  return parsed;
}

function resolveWindow(args) {
  const until = args.until ? parseTimeArg(args.until, new Date()) : new Date();
  const since = parseTimeArg(args.since, until);
  if (since.getTime() >= until.getTime()) {
    throw new NeoLogInspectorError('--since must be earlier than --until', {
      code: 'invalid_time_window',
      details: { since: since.toISOString(), until: until.toISOString() },
    });
  }
  return { since, until };
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: 'utf8',
    maxBuffer: options.maxBuffer ?? 30 * 1024 * 1024,
    timeout: options.timeoutMs ?? 60_000,
  });

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  const combined = [stdout, stderr].filter(Boolean).join('\n');
  return {
    command,
    args,
    status: result.status,
    signal: result.signal,
    stdout,
    stderr,
    combined,
    ok: result.status === 0,
    error: result.error,
  };
}

function extractFirstJsonObject(text) {
  const start = text.indexOf('{');
  if (start < 0) {
    throw new NeoLogInspectorError('Command did not return a JSON object.', {
      code: 'json_not_found',
      details: { output: text.slice(0, 500) },
    });
  }

  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return JSON.parse(text.slice(start, i + 1));
      }
    }
  }

  throw new NeoLogInspectorError('JSON object was truncated.', { code: 'json_truncated' });
}

function parseJsonLines(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Vercel occasionally prints non-log JSON-ish diagnostics. Ignore them.
    }
  }
  return rows;
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function buildSupabaseSql({ sinceIso, untilIso }) {
  const since = sqlLiteral(sinceIso);
  const until = sqlLiteral(untilIso);
  return `
WITH bounds AS (
  SELECT ${since}::timestamptz AS since_at, ${until}::timestamptz AS until_at
)
SELECT jsonb_build_object(
  'window', (
    SELECT jsonb_build_object(
      'dbNow', now(),
      'since', since_at,
      'until', until_at
    )
    FROM bounds
  ),
  'tableCounts', (
    SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.table_name), '[]'::jsonb)
    FROM (
      SELECT 'control_plane_audit_events' AS table_name, count(*)::int AS total,
        count(*) FILTER (WHERE created_at >= since_at AND created_at <= until_at)::int AS recent,
        min(created_at) AS min_at, max(created_at) AS max_at
      FROM public.control_plane_audit_events, bounds
      UNION ALL
      SELECT 'telemetry_diagnostic_bundles', count(*)::int,
        count(*) FILTER (WHERE uploaded_at >= since_at AND uploaded_at <= until_at)::int,
        min(uploaded_at), max(uploaded_at)
      FROM public.telemetry_diagnostic_bundles, bounds
      UNION ALL
      SELECT 'telemetry_feedback', count(*)::int,
        count(*) FILTER (WHERE uploaded_at >= since_at AND uploaded_at <= until_at)::int,
        min(uploaded_at), max(uploaded_at)
      FROM public.telemetry_feedback, bounds
      UNION ALL
      SELECT 'telemetry_renderer_bundle_attempts', count(*)::int,
        count(*) FILTER (WHERE uploaded_at >= since_at AND uploaded_at <= until_at)::int,
        min(uploaded_at), max(uploaded_at)
      FROM public.telemetry_renderer_bundle_attempts, bounds
      UNION ALL
      SELECT 'telemetry_sessions', count(*)::int,
        count(*) FILTER (WHERE uploaded_at >= since_at AND uploaded_at <= until_at)::int,
        min(uploaded_at), max(uploaded_at)
      FROM public.telemetry_sessions, bounds
      UNION ALL
      SELECT 'telemetry_turns', count(*)::int,
        count(*) FILTER (WHERE uploaded_at >= since_at AND uploaded_at <= until_at)::int,
        min(uploaded_at), max(uploaded_at)
      FROM public.telemetry_turns, bounds
    ) row
  ),
  'sessions', jsonb_build_object(
    'summary', (
      SELECT row_to_json(row)
      FROM (
        SELECT count(*)::int AS sessions,
          count(distinct user_id)::int AS users,
          count(*) FILTER (WHERE status = 'error')::int AS error_sessions,
          count(*) FILTER (WHERE coalesce(total_errors, 0) > 0)::int AS sessions_with_errors,
          coalesce(sum(coalesce(total_errors, 0)), 0)::int AS total_errors
        FROM public.telemetry_sessions, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
      ) row
    ),
    'byVersion', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.errorish_sessions DESC, row.sessions DESC), '[]'::jsonb)
      FROM (
        SELECT coalesce(app_version, '(null)') AS app_version,
          coalesce(status, '(null)') AS status,
          count(*)::int AS sessions,
          count(distinct user_id)::int AS users,
          count(*) FILTER (WHERE status = 'error' OR coalesce(total_errors, 0) > 0)::int AS errorish_sessions,
          coalesce(sum(coalesce(total_errors, 0)), 0)::int AS total_errors
        FROM public.telemetry_sessions, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
        GROUP BY 1, 2
        LIMIT 50
      ) row
    ),
    'errorRows', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.uploaded_at DESC), '[]'::jsonb)
      FROM (
        SELECT id, left(user_id::text, 8) AS user_prefix, app_version, model_provider, model_name,
          session_type, status, total_errors, total_tool_calls, tool_success_rate, uploaded_at
        FROM public.telemetry_sessions, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
          AND (status = 'error' OR coalesce(total_errors, 0) > 0)
        ORDER BY uploaded_at DESC
        LIMIT 50
      ) row
    )
  ),
  'turns', jsonb_build_object(
    'summary', (
      SELECT row_to_json(row)
      FROM (
        SELECT count(*)::int AS turns,
          count(distinct session_id)::int AS sessions,
          count(distinct user_id)::int AS users,
          count(*) FILTER (
            WHERE coalesce(error_count, 0) > 0
              OR lower(coalesce(outcome_status, '')) IN ('error', 'failed', 'failure')
          )::int AS turns_with_errors,
          coalesce(sum(coalesce(error_count, 0)), 0)::int AS total_turn_errors
        FROM public.telemetry_turns, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
      ) row
    ),
    'status', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.total_errors DESC, row.turns DESC), '[]'::jsonb)
      FROM (
        SELECT coalesce(outcome_status, '(null)') AS outcome_status,
          count(*)::int AS turns,
          coalesce(sum(coalesce(error_count, 0)), 0)::int AS total_errors
        FROM public.telemetry_turns, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
        GROUP BY 1
      ) row
    ),
    'failedTools', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC, row.last_at DESC), '[]'::jsonb)
      FROM (
        SELECT coalesce(tool_call->>'name', '(unknown)') AS tool_name,
          coalesce(tool_call->>'errorCategory', '(null)') AS error_category,
          left(coalesce(tool_call->>'errorMessage', ''), 240) AS error_message,
          count(*)::int AS n,
          max(turn.uploaded_at) AS last_at
        FROM public.telemetry_turns turn
        CROSS JOIN bounds
        CROSS JOIN LATERAL jsonb_array_elements(coalesce(turn.payload->'toolCalls', '[]'::jsonb)) tool_call
        WHERE turn.uploaded_at >= since_at AND turn.uploaded_at <= until_at
          AND coalesce(tool_call->>'success', 'true') = 'false'
        GROUP BY 1, 2, 3
      ) row
    )
  ),
  'feedback', jsonb_build_object(
    'summary', (
      SELECT row_to_json(row)
      FROM (
        SELECT count(*)::int AS feedback,
          count(*) FILTER (WHERE rating = -1)::int AS negative_feedback
        FROM public.telemetry_feedback, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
      ) row
    ),
    'negativeRows', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.uploaded_at DESC), '[]'::jsonb)
      FROM (
        SELECT session_id, turn_id, left(user_id::text, 8) AS user_prefix,
          rating, left(coalesce(comment, ''), 240) AS comment, uploaded_at
        FROM public.telemetry_feedback, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
          AND rating = -1
        ORDER BY uploaded_at DESC
        LIMIT 50
      ) row
    )
  ),
  'diagnostics', jsonb_build_object(
    'summary', (
      SELECT row_to_json(row)
      FROM (
        SELECT count(*)::int AS bundles,
          count(distinct session_id)::int AS sessions,
          count(distinct user_id)::int AS users
        FROM public.telemetry_diagnostic_bundles, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
      ) row
    ),
    'rows', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.uploaded_at DESC), '[]'::jsonb)
      FROM (
        SELECT id, session_id, left(user_id::text, 8) AS user_prefix, app_version,
          agent_version, prompt_version, tool_schema_version, trigger_reason, uploaded_at
        FROM public.telemetry_diagnostic_bundles, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
        ORDER BY uploaded_at DESC
        LIMIT 50
      ) row
    )
  ),
  'rendererBundle', jsonb_build_object(
    'summary', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC, row.last_uploaded_at DESC), '[]'::jsonb)
      FROM (
        SELECT coalesce(app_version, '(null)') AS app_version,
          coalesce(source_channel, '(null)') AS source_channel,
          coalesce(outcome, '(null)') AS outcome,
          coalesce(reason, '(null)') AS reason,
          coalesce(source_error_reason, '(null)') AS source_error_reason,
          count(*)::int AS n,
          max(uploaded_at) AS last_uploaded_at
        FROM public.telemetry_renderer_bundle_attempts, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
        GROUP BY 1, 2, 3, 4, 5
      ) row
    ),
    'problemRows', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.uploaded_at DESC), '[]'::jsonb)
      FROM (
        SELECT left(user_id::text, 8) AS user_prefix, app_version, source_channel, outcome, reason,
          source_error_reason, left(coalesce(source_error_message, ''), 240) AS source_error_message,
          left(coalesce(error_message, ''), 240) AS error_message, rollback_to_builtin, rollback_reason,
          missing_shell_capabilities, missing_runtime_assets, missing_resources, diagnostics, checked_at, uploaded_at
        FROM public.telemetry_renderer_bundle_attempts, bounds
        WHERE uploaded_at >= since_at AND uploaded_at <= until_at
          AND (
            outcome <> 'applied'
            OR reason IS NOT NULL
            OR source_error_reason IS NOT NULL
            OR nullif(source_error_message, '') IS NOT NULL
            OR nullif(error_message, '') IS NOT NULL
          )
        ORDER BY uploaded_at DESC
        LIMIT 50
      ) row
    )
  ),
  'controlPlane', jsonb_build_object(
    'summary', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC, row.last_at DESC), '[]'::jsonb)
      FROM (
        SELECT artifact_kind, outcome, coalesce(error_code, '(null)') AS error_code,
          status_code, count(*)::int AS n, max(created_at) AS last_at
        FROM public.control_plane_audit_events, bounds
        WHERE created_at >= since_at AND created_at <= until_at
        GROUP BY 1, 2, 3, 4
      ) row
    ),
    'errors', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC, row.last_at DESC), '[]'::jsonb)
      FROM (
        SELECT artifact_kind, outcome, coalesce(error_code, '(null)') AS error_code,
          status_code, count(*)::int AS n, max(created_at) AS last_at
        FROM public.control_plane_audit_events, bounds
        WHERE created_at >= since_at AND created_at <= until_at
          AND (outcome = 'error' OR status_code >= 400 OR error_code IS NOT NULL)
        GROUP BY 1, 2, 3, 4
      ) row
    ),
    'cloudConfigHourlySubjects', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.hour DESC, row.n DESC), '[]'::jsonb)
      FROM (
        SELECT date_trunc('hour', created_at) AS hour,
          coalesce(subject_source, '(null)') AS subject_source,
          CASE WHEN subject_id IS NULL THEN '(null)' ELSE left(subject_id, 12) END AS subject_prefix,
          count(*)::int AS n,
          min(created_at) AS first_at,
          max(created_at) AS last_at
        FROM public.control_plane_audit_events, bounds
        WHERE created_at >= since_at AND created_at <= until_at
          AND artifact_kind = 'cloud_config'
        GROUP BY 1, 2, 3
        ORDER BY hour DESC, n DESC
        LIMIT 200
      ) row
    ),
    'cloudConfigTopSubjects', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC), '[]'::jsonb)
      FROM (
        SELECT coalesce(subject_source, '(null)') AS subject_source,
          CASE WHEN subject_id IS NULL THEN '(null)' ELSE left(subject_id, 12) END AS subject_prefix,
          count(*)::int AS n,
          min(created_at) AS first_at,
          max(created_at) AS last_at
        FROM public.control_plane_audit_events, bounds
        WHERE created_at >= since_at AND created_at <= until_at
          AND artifact_kind = 'cloud_config'
        GROUP BY 1, 2
        ORDER BY n DESC
        LIMIT 20
      ) row
    ),
    'cloudConfigTopUserAgents', (
      SELECT coalesce(jsonb_agg(to_jsonb(row) ORDER BY row.n DESC), '[]'::jsonb)
      FROM (
        SELECT left(coalesce(user_agent, '(null)'), 160) AS user_agent,
          count(*)::int AS n,
          min(created_at) AS first_at,
          max(created_at) AS last_at
        FROM public.control_plane_audit_events, bounds
        WHERE created_at >= since_at AND created_at <= until_at
          AND artifact_kind = 'cloud_config'
        GROUP BY 1
        ORDER BY n DESC
        LIMIT 20
      ) row
    )
  )
) AS report;
`.trim();
}

function runSupabaseQuery(window) {
  const sql = buildSupabaseSql({
    sinceIso: window.since.toISOString(),
    untilIso: window.until.toISOString(),
  });
  const result = runCommand('supabase', ['db', 'query', '--linked', sql, '-o', 'json'], {
    timeoutMs: 90_000,
  });

  if (!result.ok) {
    return {
      ok: false,
      error: summarizeCommandFailure(result),
    };
  }

  try {
    const parsed = extractFirstJsonObject(result.combined);
    const report = parsed.rows?.[0]?.report;
    if (!report) {
      throw new NeoLogInspectorError('Supabase query returned no report row.', {
        code: 'missing_supabase_report',
        details: parsed,
      });
    }
    return { ok: true, report };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runVercelLogQuery({ label, args, sinceIso, untilIso, project, environment, limit }) {
  const cliArgs = [
    'logs',
    '--environment', environment,
    '--since', sinceIso,
    '--until', untilIso,
    '--json',
    '--limit', String(limit),
    '--project', project,
    ...args,
  ];
  const result = runCommand('vercel', cliArgs, { timeoutMs: 90_000 });
  const entries = parseJsonLines(result.combined);
  return {
    label,
    ok: result.ok,
    error: result.ok ? null : summarizeCommandFailure(result),
    entries,
  };
}

function runVercelQueries({ window, project, environment, limit }) {
  const common = {
    sinceIso: window.since.toISOString(),
    untilIso: window.until.toISOString(),
    project,
    environment,
    limit,
  };
  const queries = [
    runVercelLogQuery({ ...common, label: 'error level', args: ['--level', 'error'] }),
    runVercelLogQuery({ ...common, label: 'warning level', args: ['--level', 'warning'] }),
    runVercelLogQuery({ ...common, label: '4xx status', args: ['--status-code', '4xx'] }),
    runVercelLogQuery({ ...common, label: '5xx status', args: ['--status-code', '5xx'] }),
  ];
  const unique = new Map();
  for (const query of queries) {
    for (const entry of query.entries) {
      unique.set(entry.id ?? `${query.label}:${unique.size}`, entry);
    }
  }
  return {
    ok: queries.every((query) => query.ok),
    queries,
    uniqueEntries: [...unique.values()],
    summary: summarizeVercelEntries([...unique.values()]),
  };
}

function summarizeCommandFailure(result) {
  const detail = result.combined.trim() || result.error?.message || 'no output';
  return `${result.command} ${result.args.join(' ')} failed (${result.status ?? result.signal ?? 'unknown'}): ${detail.slice(0, 800)}`;
}

function summarizeVercelEntries(entries) {
  const byStatus = new Map();
  const byPath = new Map();
  const byLevel = new Map();
  for (const entry of entries) {
    increment(byStatus, String(entry.responseStatusCode ?? '(none)'));
    increment(byPath, entry.requestPath ?? '(none)');
    increment(byLevel, entry.level ?? '(none)');
  }
  return {
    total: entries.length,
    byStatus: sortedEntries(byStatus),
    byPath: sortedEntries(byPath).slice(0, 20),
    byLevel: sortedEntries(byLevel),
    samples: entries.slice(0, 10).map((entry) => ({
      timestamp: entry.timestamp,
      level: entry.level,
      status: entry.responseStatusCode,
      method: entry.requestMethod,
      path: entry.requestPath,
      message: entry.message,
      id: entry.id,
    })),
  };
}

function increment(map, key, amount = 1) {
  map.set(key, (map.get(key) ?? 0) + amount);
}

function sortedEntries(map) {
  return [...map.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asNumber(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

function buildFindings({ supabase, vercel, spikeThreshold }) {
  const findings = [];

  if (supabase?.ok) {
    const report = supabase.report;
    const sessionSummary = report.sessions?.summary ?? {};
    const turnSummary = report.turns?.summary ?? {};
    const feedbackSummary = report.feedback?.summary ?? {};
    const diagnosticSummary = report.diagnostics?.summary ?? {};
    const failedTools = asArray(report.turns?.failedTools);
    const controlPlaneErrors = asArray(report.controlPlane?.errors);
    const rendererProblemRows = asArray(report.rendererBundle?.problemRows);
    const cloudConfigSpikes = asArray(report.controlPlane?.cloudConfigHourlySubjects)
      .filter((row) => asNumber(row.n) >= spikeThreshold);

    const sessionErrors = asNumber(sessionSummary.error_sessions) + asNumber(sessionSummary.sessions_with_errors);
    const turnErrors = asNumber(turnSummary.turns_with_errors) + asNumber(turnSummary.total_turn_errors);
    if (sessionErrors > 0 || turnErrors > 0 || failedTools.length > 0) {
      findings.push({
        severity: 'error',
        area: 'user telemetry',
        message: `${sessionErrors} error-ish session signals, ${turnErrors} turn error signals, ${failedTools.length} failed tool groups`,
      });
    }

    if (asNumber(feedbackSummary.negative_feedback) > 0) {
      findings.push({
        severity: 'warning',
        area: 'feedback',
        message: `${feedbackSummary.negative_feedback} negative feedback row(s) in the window`,
      });
    }

    if (asNumber(diagnosticSummary.bundles) > 0) {
      findings.push({
        severity: 'warning',
        area: 'diagnostics',
        message: `${diagnosticSummary.bundles} diagnostic bundle(s) uploaded`,
      });
    }

    if (controlPlaneErrors.length > 0) {
      const count = controlPlaneErrors.reduce((sum, row) => sum + asNumber(row.n), 0);
      findings.push({
        severity: 'error',
        area: 'control plane',
        message: `${count} control-plane error/non-2xx audit event(s)`,
      });
    }

    const notableRendererRows = rendererProblemRows.filter((row) => {
      const reason = row.reason ?? '';
      return reason !== 'already-current';
    });
    if (notableRendererRows.length > 0) {
      findings.push({
        severity: 'warning',
        area: 'renderer hot-update',
        message: `${notableRendererRows.length} non-current renderer bundle skip/failure row(s)`,
      });
    }

    if (cloudConfigSpikes.length > 0) {
      findings.push({
        severity: 'warning',
        area: 'control-plane traffic',
        message: `${cloudConfigSpikes.length} cloud_config subject/hour bucket(s) exceeded ${spikeThreshold} request(s)`,
      });
    }
  } else if (supabase) {
    findings.push({
      severity: 'warning',
      area: 'supabase',
      message: `Supabase telemetry query failed: ${supabase.error}`,
    });
  }

  if (vercel) {
    if (!vercel.ok) {
      findings.push({
        severity: 'warning',
        area: 'vercel',
        message: 'One or more Vercel log queries failed',
      });
    }
    const vercelErrors = vercel.uniqueEntries.filter((entry) => {
      const status = asNumber(entry.responseStatusCode);
      return entry.level === 'error' || status >= 400;
    });
    if (vercelErrors.length > 0) {
      findings.push({
        severity: 'error',
        area: 'vercel',
        message: `${vercelErrors.length} Vercel error/4xx/5xx log row(s)`,
      });
    }
  }

  return findings;
}

function formatDate(value) {
  if (!value) return '-';
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function printTable(rows, columns) {
  if (!rows.length) {
    console.log('  - none');
    return;
  }
  for (const row of rows) {
    const parts = columns.map(([label, getter]) => `${label}=${getter(row) ?? '-'}`);
    console.log(`  - ${parts.join(' | ')}`);
  }
}

function printMarkdownReport({ args, window, supabase, vercel, findings }) {
  console.log('# Agent Neo Error Log Report');
  console.log('');
  console.log(`Window: ${formatDate(window.since)} -> ${formatDate(window.until)} (Asia/Shanghai)`);
  console.log(`Sources: ${args.skipSupabase ? 'Supabase skipped' : 'Supabase linked project'}; ${args.skipVercel ? 'Vercel skipped' : `Vercel ${args.project}/${args.environment}`}`);
  console.log('');

  const errorFindings = findings.filter((finding) => finding.severity === 'error');
  const warningFindings = findings.filter((finding) => finding.severity === 'warning');
  if (errorFindings.length === 0) {
    console.log('Verdict: no confirmed service/user-runtime errors found in enabled sources.');
  } else {
    console.log(`Verdict: ${errorFindings.length} confirmed error area(s) found.`);
  }
  if (warningFindings.length > 0) {
    console.log(`Attention: ${warningFindings.length} warning area(s) need follow-up.`);
  }
  console.log('');

  console.log('## Findings');
  if (findings.length === 0) {
    console.log('- none');
  } else {
    for (const finding of findings) {
      console.log(`- [${finding.severity}] ${finding.area}: ${finding.message}`);
    }
  }
  console.log('');

  if (supabase?.ok) {
    const report = supabase.report;
    console.log('## Supabase Telemetry');
    const sessionSummary = report.sessions?.summary ?? {};
    const turnSummary = report.turns?.summary ?? {};
    const feedbackSummary = report.feedback?.summary ?? {};
    const diagnosticSummary = report.diagnostics?.summary ?? {};
    console.log(`- sessions=${sessionSummary.sessions ?? 0}, users=${sessionSummary.users ?? 0}, error_sessions=${sessionSummary.error_sessions ?? 0}, sessions_with_errors=${sessionSummary.sessions_with_errors ?? 0}, total_errors=${sessionSummary.total_errors ?? 0}`);
    console.log(`- turns=${turnSummary.turns ?? 0}, turn_sessions=${turnSummary.sessions ?? 0}, turns_with_errors=${turnSummary.turns_with_errors ?? 0}, total_turn_errors=${turnSummary.total_turn_errors ?? 0}`);
    console.log(`- feedback=${feedbackSummary.feedback ?? 0}, negative_feedback=${feedbackSummary.negative_feedback ?? 0}`);
    console.log(`- diagnostic_bundles=${diagnosticSummary.bundles ?? 0}`);
    console.log('');

    console.log('### Error Sessions');
    printTable(asArray(report.sessions?.errorRows), [
      ['session', (row) => row.id],
      ['user', (row) => row.user_prefix],
      ['version', (row) => row.app_version],
      ['status', (row) => row.status],
      ['errors', (row) => row.total_errors],
      ['uploaded', (row) => formatDate(row.uploaded_at)],
    ]);
    console.log('');

    console.log('### Failed Tools');
    printTable(asArray(report.turns?.failedTools), [
      ['tool', (row) => row.tool_name],
      ['category', (row) => row.error_category],
      ['count', (row) => row.n],
      ['message', (row) => row.error_message || '(empty)'],
      ['last', (row) => formatDate(row.last_at)],
    ]);
    console.log('');

    console.log('### Renderer Hot-Update Rows');
    printTable(asArray(report.rendererBundle?.problemRows), [
      ['user', (row) => row.user_prefix],
      ['version', (row) => row.app_version],
      ['outcome', (row) => row.outcome],
      ['reason', (row) => row.reason ?? '(null)'],
      ['missingCaps', (row) => asArray(row.missing_shell_capabilities).join(',') || '(none)'],
      ['diagnostics', (row) => asArray(row.diagnostics).join(',') || '(none)'],
      ['uploaded', (row) => formatDate(row.uploaded_at)],
    ]);
    console.log('');

    console.log('### Control Plane Errors');
    printTable(asArray(report.controlPlane?.errors), [
      ['artifact', (row) => row.artifact_kind],
      ['outcome', (row) => row.outcome],
      ['status', (row) => row.status_code],
      ['error', (row) => row.error_code],
      ['count', (row) => row.n],
      ['last', (row) => formatDate(row.last_at)],
    ]);
    console.log('');

    const spikes = asArray(report.controlPlane?.cloudConfigHourlySubjects)
      .filter((row) => asNumber(row.n) >= args.spikeThreshold);
    console.log(`### cloud_config Traffic Buckets >= ${args.spikeThreshold}/hour`);
    printTable(spikes, [
      ['hour', (row) => formatDate(row.hour)],
      ['subject', (row) => `${row.subject_source}:${row.subject_prefix}`],
      ['count', (row) => row.n],
      ['first', (row) => formatDate(row.first_at)],
      ['last', (row) => formatDate(row.last_at)],
    ]);
    console.log('');

    console.log('### cloud_config Top Subjects');
    printTable(asArray(report.controlPlane?.cloudConfigTopSubjects).slice(0, 10), [
      ['subject', (row) => `${row.subject_source}:${row.subject_prefix}`],
      ['count', (row) => row.n],
      ['first', (row) => formatDate(row.first_at)],
      ['last', (row) => formatDate(row.last_at)],
    ]);
    console.log('');
  } else if (supabase) {
    console.log('## Supabase Telemetry');
    console.log(`- query failed: ${supabase.error}`);
    console.log('');
  }

  if (vercel) {
    console.log('## Vercel Logs');
    console.log(`- unique error/warning/4xx/5xx rows=${vercel.summary.total}`);
    console.log(`- by_status=${vercel.summary.byStatus.map((row) => `${row.key}:${row.count}`).join(', ') || 'none'}`);
    console.log(`- by_level=${vercel.summary.byLevel.map((row) => `${row.key}:${row.count}`).join(', ') || 'none'}`);
    if (!vercel.ok) {
      for (const query of vercel.queries.filter((item) => !item.ok)) {
        console.log(`- ${query.label} failed: ${query.error}`);
      }
    }
    console.log('');
    console.log('### Vercel Samples');
    printTable(vercel.summary.samples, [
      ['time', (row) => formatDate(row.timestamp)],
      ['level', (row) => row.level],
      ['status', (row) => row.status],
      ['path', (row) => row.path],
      ['message', (row) => row.message || '(empty)'],
    ]);
    console.log('');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  const window = resolveWindow(args);
  const supabase = args.skipSupabase ? null : runSupabaseQuery(window);
  const vercel = args.skipVercel
    ? null
    : runVercelQueries({
      window,
      project: args.project,
      environment: args.environment,
      limit: args.limit,
    });
  const findings = buildFindings({
    supabase,
    vercel,
    spikeThreshold: args.spikeThreshold,
  });

  if (args.json) {
    console.log(JSON.stringify({
      window: {
        since: window.since.toISOString(),
        until: window.until.toISOString(),
      },
      args,
      supabase,
      vercel,
      findings,
    }, null, 2));
  } else {
    printMarkdownReport({ args, window, supabase, vercel, findings });
  }

  const hasConfirmedErrors = findings.some((finding) => finding.severity === 'error');
  if (hasConfirmedErrors) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(2);
});
