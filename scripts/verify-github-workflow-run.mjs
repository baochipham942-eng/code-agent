#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export class GithubWorkflowRunVerificationError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'GithubWorkflowRunVerificationError';
    this.code = options.code ?? 'github_workflow_run_verification_failed';
    this.details = options.details;
  }
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readArg(args, name) {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === name) {
      return args[index + 1];
    }
    if (arg.startsWith(`${name}=`)) {
      return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new GithubWorkflowRunVerificationError(`${name} must be a positive integer`, {
      code: 'invalid_args',
      details: { [name]: value },
    });
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new GithubWorkflowRunVerificationError(`${name} must be a non-negative integer`, {
      code: 'invalid_args',
      details: { [name]: value },
    });
  }
  return parsed;
}

function isTerminalStatus(status) {
  return status === 'completed';
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function summarizeRun(run) {
  return {
    id: run.id,
    name: run.name,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    headSha: run.head_sha,
    headBranch: run.head_branch,
    htmlUrl: run.html_url,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function parseRunTimestamp(run) {
  for (const field of ['updated_at', 'run_started_at', 'created_at']) {
    const timestamp = Date.parse(run?.[field] ?? '');
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }
  return 0;
}

function parseRunId(run) {
  const parsed = Number(run?.id);
  return Number.isFinite(parsed) ? parsed : 0;
}

function compareRunsNewestFirst(left, right) {
  const timestampDiff = parseRunTimestamp(right) - parseRunTimestamp(left);
  if (timestampDiff !== 0) {
    return timestampDiff;
  }
  return parseRunId(right) - parseRunId(left);
}

function matchesWorkflowRun(candidate, { headSha, event, branch }) {
  return Boolean(
    candidate
    && candidate.head_sha === headSha
    && (!event || candidate.event === event)
    && (!branch || candidate.head_branch === branch),
  );
}

function selectLatestMatchingWorkflowRun(runs, options) {
  return runs
    .filter((candidate) => matchesWorkflowRun(candidate, options))
    .sort(compareRunsNewestFirst)[0] ?? null;
}

function assertWorkflowRun(run, options) {
  if (!run) {
    return { matched: false, reason: 'missing' };
  }
  if (!isTerminalStatus(run.status)) {
    return { matched: false, reason: 'pending', run: summarizeRun(run) };
  }
  if (run.conclusion !== options.expectedConclusion) {
    throw new GithubWorkflowRunVerificationError(
      `workflow ${options.workflow} completed with conclusion=${run.conclusion}; expected ${options.expectedConclusion}`,
      {
        code: 'unexpected_conclusion',
        details: { run: summarizeRun(run), expectedConclusion: options.expectedConclusion },
      },
    );
  }
  return { matched: true, run: summarizeRun(run) };
}

function summarizeCandidateRuns(runs, limit = 5) {
  return [...runs].sort(compareRunsNewestFirst).slice(0, limit).map((run) => summarizeRun(run));
}

function buildWorkflowRunsUrl({ apiBaseUrl, repo, workflow, event, headSha, branch, perPage }) {
  const url = new URL(
    `/repos/${encodeURIComponent(repo).replace(/%2F/g, '/')}/actions/workflows/${encodeURIComponent(workflow)}/runs`,
    apiBaseUrl.endsWith('/') ? apiBaseUrl : `${apiBaseUrl}/`,
  );
  url.searchParams.set('per_page', String(perPage));
  if (event) url.searchParams.set('event', event);
  if (headSha) url.searchParams.set('head_sha', headSha);
  if (branch) url.searchParams.set('branch', branch);
  return url;
}

async function fetchWorkflowRuns(fetchImpl, url, token) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw new GithubWorkflowRunVerificationError('GitHub workflow runs response is not valid JSON', {
      code: 'invalid_github_response',
      details: { status: response.status, textSample: text.slice(0, 500) },
    });
  }
  if (!response.ok) {
    throw new GithubWorkflowRunVerificationError(
      `GitHub workflow runs API returned HTTP ${response.status}`,
      {
        code: 'github_http_status',
        details: { status: response.status, body },
      },
    );
  }
  if (!Array.isArray(body.workflow_runs)) {
    throw new GithubWorkflowRunVerificationError('GitHub workflow runs response is missing workflow_runs[]', {
      code: 'invalid_github_response',
      details: body,
    });
  }
  return body.workflow_runs;
}

export async function verifyGithubWorkflowRun({
  repo,
  workflow,
  headSha,
  event = 'push',
  branch,
  expectedConclusion = 'success',
  timeoutMs = 600000,
  pollMs = 30000,
  perPage = 20,
  token,
  apiBaseUrl = 'https://api.github.com',
  fetchImpl = globalThis.fetch,
  sleepImpl = sleep,
  now = () => Date.now(),
} = {}) {
  if (!repo) {
    throw new GithubWorkflowRunVerificationError('repo is required', { code: 'missing_repo' });
  }
  if (!workflow) {
    throw new GithubWorkflowRunVerificationError('workflow is required', { code: 'missing_workflow' });
  }
  if (!headSha) {
    throw new GithubWorkflowRunVerificationError('headSha is required', { code: 'missing_head_sha' });
  }
  if (typeof fetchImpl !== 'function') {
    throw new GithubWorkflowRunVerificationError('fetch is not available in this Node.js runtime.', {
      code: 'missing_fetch',
    });
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  const url = buildWorkflowRunsUrl({
    apiBaseUrl,
    repo,
    workflow,
    event,
    headSha,
    branch,
    perPage,
  });
  let attempts = 0;
  let lastObservation = null;
  let latestCandidates = [];

  while (true) {
    attempts += 1;
    const runs = await fetchWorkflowRuns(fetchImpl, url, token);
    latestCandidates = summarizeCandidateRuns(runs);
    const run = selectLatestMatchingWorkflowRun(runs, { headSha, event, branch });
    const result = assertWorkflowRun(run, { workflow, expectedConclusion });
    lastObservation = result.run ?? { reason: result.reason };
    if (result.matched) {
      return {
        workflow,
        repo,
        headSha,
        event,
        branch: branch ?? null,
        attempts,
        run: result.run,
      };
    }
    if (now() >= deadline) {
      throw new GithubWorkflowRunVerificationError(
        `workflow ${workflow} did not complete with conclusion=${expectedConclusion} before timeout`,
        {
          code: 'timeout',
          details: {
            workflow,
            repo,
            headSha,
            event,
            branch: branch ?? null,
            timeoutMs,
            attempts,
            lastObservation,
            latestCandidates,
          },
        },
      );
    }
    await sleepImpl(pollMs);
  }
}

export function parseGithubWorkflowRunArgs(argv = process.argv.slice(2), env = process.env) {
  const timeoutMs = normalizeNonNegativeInteger(
    readArg(argv, '--timeout-ms') ?? env.GITHUB_WORKFLOW_RUN_VERIFY_TIMEOUT_MS ?? '600000',
    'timeoutMs',
  );
  const pollMs = normalizeNonNegativeInteger(
    readArg(argv, '--poll-ms') ?? env.GITHUB_WORKFLOW_RUN_VERIFY_POLL_MS ?? '30000',
    'pollMs',
  );
  const perPage = normalizePositiveInteger(readArg(argv, '--per-page') ?? '20', 'perPage');
  return {
    repo: normalizeOptionalString(readArg(argv, '--repo')) ?? normalizeOptionalString(env.GITHUB_REPOSITORY),
    workflow: normalizeOptionalString(readArg(argv, '--workflow')),
    headSha: normalizeOptionalString(readArg(argv, '--head-sha')) ?? normalizeOptionalString(env.GITHUB_SHA),
    event: normalizeOptionalString(readArg(argv, '--event')) ?? 'push',
    branch: normalizeOptionalString(readArg(argv, '--branch')),
    expectedConclusion: normalizeOptionalString(readArg(argv, '--expected-conclusion')) ?? 'success',
    timeoutMs,
    pollMs,
    perPage,
    token: normalizeOptionalString(readArg(argv, '--token')) ?? normalizeOptionalString(env.GITHUB_TOKEN),
  };
}

function usage() {
  return [
    'Usage: node scripts/verify-github-workflow-run.mjs --workflow <workflow.yml> --head-sha <sha> [--repo owner/repo]',
    '',
    'Options:',
    '  --workflow <workflow.yml>          Workflow file name or id, for example renderer-bundle.yml',
    '  --repo <owner/repo>                Defaults to GITHUB_REPOSITORY',
    '  --head-sha <sha>                  Defaults to GITHUB_SHA',
    '  --event <event>                   Defaults to push',
    '  --branch <branch>                 Optional head_branch filter',
    '  --expected-conclusion <value>     Defaults to success',
    '  --timeout-ms <n>                  Defaults to 600000',
    '  --poll-ms <n>                     Defaults to 30000',
    '  --per-page <n>                    Defaults to 20',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const summary = await verifyGithubWorkflowRun(parseGithubWorkflowRunArgs(argv));
  process.stdout.write('[verify-github-workflow-run] passed\n');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (error instanceof GithubWorkflowRunVerificationError) {
      process.stderr.write(`[verify-github-workflow-run] ${error.message}\n`);
      if (error.details !== undefined) {
        process.stderr.write(`${JSON.stringify(error.details, null, 2)}\n`);
      }
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`${error.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
