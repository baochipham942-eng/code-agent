#!/usr/bin/env node
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import {
  GithubWorkflowRunVerificationError,
  verifyGithubWorkflowRun,
} from './verify-github-workflow-run.mjs';
import {
  parseRendererHotUpdateProductionArgs,
  RendererHotUpdateProductionVerificationError,
  verifyRendererHotUpdateProductionWithRetry,
} from './verify-renderer-hot-update-production.mjs';

export class RendererHotUpdateReleaseGateError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'RendererHotUpdateReleaseGateError';
    this.code = options.code ?? 'renderer_hot_update_release_gate_failed';
    this.details = options.details;
  }
}

function hasFlag(args, name) {
  return args.includes(name);
}

function readArg(args, names) {
  const aliases = Array.isArray(names) ? names : [names];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    for (const name of aliases) {
      if (arg === name) {
        return args[index + 1];
      }
      if (arg.startsWith(`${name}=`)) {
        return arg.slice(name.length + 1);
      }
    }
  }
  return undefined;
}

function normalizeOptionalString(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeTagVersion(refName) {
  const normalized = normalizeOptionalString(refName);
  if (!normalized) return undefined;
  if (!/^v\d+\.\d+\.\d+(?:[-+].*)?$/.test(normalized)) return undefined;
  return normalized.slice(1);
}

function defaultWorkflowBranch(env) {
  return normalizeOptionalString(env.RENDERER_BUNDLE_WORKFLOW_BRANCH)
    ?? (normalizeOptionalString(env.GITHUB_REF_TYPE) === 'tag'
      ? normalizeOptionalString(env.GITHUB_REF_NAME)
      : undefined);
}

function normalizePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new RendererHotUpdateReleaseGateError(`${name} must be a positive integer`, {
      code: 'invalid_args',
      details: { [name]: value },
    });
  }
  return parsed;
}

function normalizeNonNegativeInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new RendererHotUpdateReleaseGateError(`${name} must be a non-negative integer`, {
      code: 'invalid_args',
      details: { [name]: value },
    });
  }
  return parsed;
}

function stripWorkflowArgs(argv) {
  const workflowOptions = new Set([
    '--workflow',
    '--repo',
    '--head-sha',
    '--workflow-event',
    '--workflow-branch',
    '--workflow-expected-conclusion',
    '--workflow-timeout-ms',
    '--workflow-poll-ms',
    '--workflow-per-page',
    '--github-token',
  ]);
  const workflowFlags = new Set([
    '--skip-workflow-run',
  ]);
  const stripped = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const optionName = arg.startsWith('--') && arg.includes('=')
      ? arg.slice(0, arg.indexOf('='))
      : arg;
    if (workflowFlags.has(optionName)) {
      continue;
    }
    if (workflowOptions.has(optionName)) {
      if (!arg.includes('=')) {
        index += 1;
      }
      continue;
    }
    stripped.push(arg);
  }
  return stripped;
}

export function parseRendererHotUpdateReleaseGateArgs(argv = process.argv.slice(2), env = process.env) {
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    return { help: true };
  }

  const expectedVersion = normalizeOptionalString(readArg(argv, '--expected-version'))
    ?? normalizeOptionalString(env.RENDERER_BUNDLE_EXPECTED_VERSION)
    ?? (normalizeOptionalString(env.GITHUB_REF_TYPE) === 'tag'
      ? normalizeTagVersion(env.GITHUB_REF_NAME)
      : undefined);
  const productionEnv = {
    ...env,
    ...(expectedVersion ? { RENDERER_BUNDLE_EXPECTED_VERSION: expectedVersion } : {}),
    RENDERER_BUNDLE_EXPECTED_RELEASE_CHANNEL:
      normalizeOptionalString(readArg(argv, '--expected-release-channel'))
      ?? normalizeOptionalString(env.RENDERER_BUNDLE_EXPECTED_RELEASE_CHANNEL)
      ?? 'latest',
  };

  return {
    skipWorkflowRun: hasFlag(argv, '--skip-workflow-run'),
    workflowRun: {
      repo: normalizeOptionalString(readArg(argv, '--repo')) ?? normalizeOptionalString(env.GITHUB_REPOSITORY),
      workflow: normalizeOptionalString(readArg(argv, '--workflow')) ?? normalizeOptionalString(env.RENDERER_BUNDLE_WORKFLOW) ?? 'renderer-bundle.yml',
      headSha: normalizeOptionalString(readArg(argv, '--head-sha')) ?? normalizeOptionalString(env.GITHUB_SHA),
      event: normalizeOptionalString(readArg(argv, '--workflow-event')) ?? 'push',
      branch: normalizeOptionalString(readArg(argv, '--workflow-branch')) ?? defaultWorkflowBranch(env),
      expectedConclusion: normalizeOptionalString(readArg(argv, '--workflow-expected-conclusion')) ?? 'success',
      timeoutMs: normalizeNonNegativeInteger(
        readArg(argv, '--workflow-timeout-ms') ?? env.RENDERER_BUNDLE_WORKFLOW_VERIFY_TIMEOUT_MS ?? '1800000',
        'workflowTimeoutMs',
      ),
      pollMs: normalizeNonNegativeInteger(
        readArg(argv, '--workflow-poll-ms') ?? env.RENDERER_BUNDLE_WORKFLOW_VERIFY_POLL_MS ?? '30000',
        'workflowPollMs',
      ),
      perPage: normalizePositiveInteger(readArg(argv, '--workflow-per-page') ?? '20', 'workflowPerPage'),
      token: normalizeOptionalString(readArg(argv, '--github-token')) ?? normalizeOptionalString(env.GITHUB_TOKEN),
    },
    production: parseRendererHotUpdateProductionArgs(stripWorkflowArgs(argv), productionEnv),
  };
}

export async function verifyRendererHotUpdateReleaseGate({
  skipWorkflowRun = false,
  workflowRun,
  production,
  verifyGithubWorkflowRunImpl = verifyGithubWorkflowRun,
  verifyRendererHotUpdateProductionWithRetryImpl = verifyRendererHotUpdateProductionWithRetry,
} = {}) {
  const summary = {};
  if (skipWorkflowRun) {
    summary.workflowRun = { skipped: true };
  } else {
    summary.workflowRun = {
      skipped: false,
      ...(await verifyGithubWorkflowRunImpl(workflowRun)),
    };
  }

  summary.production = await verifyRendererHotUpdateProductionWithRetryImpl(production);
  return summary;
}

function usage() {
  return [
    'Usage: npm run renderer:verify-release-gate -- --expected-version <version> [options]',
    '',
    'Checks a formal release before app artifacts are published:',
    '  1. Paired renderer-bundle workflow completed successfully for the same head sha',
    '  2. Production renderer hot-update control-plane + OSS manifest/bundle/release-record are current',
    '',
    'Workflow options:',
    '  --workflow <workflow.yml>              Default: renderer-bundle.yml',
    '  --repo <owner/repo>                    Default: GITHUB_REPOSITORY',
    '  --head-sha <sha>                       Default: GITHUB_SHA',
    '  --workflow-event <event>               Default: push',
    '  --workflow-branch <branch>             Optional head_branch filter',
    '  --workflow-timeout-ms <n>              Default: 1800000',
    '  --workflow-poll-ms <n>                 Default: 30000',
    '  --workflow-per-page <n>                Default: 20',
    '  --github-token <token>                 GitHub Actions API token; defaults to GITHUB_TOKEN',
    '  --skip-workflow-run                    Only run production hot-update verification',
    '',
    'All renderer:verify-production options are also supported.',
  ].join('\n');
}

async function main() {
  const argv = process.argv.slice(2);
  if (hasFlag(argv, '--help') || hasFlag(argv, '-h')) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const summary = await verifyRendererHotUpdateReleaseGate(parseRendererHotUpdateReleaseGateArgs(argv));
  process.stdout.write('[verify-renderer-hot-update-release-gate] passed\n');
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    if (
      error instanceof RendererHotUpdateReleaseGateError
      || error instanceof GithubWorkflowRunVerificationError
      || error instanceof RendererHotUpdateProductionVerificationError
    ) {
      process.stderr.write(`[verify-renderer-hot-update-release-gate] ${error.message}\n`);
      if (error.failures !== undefined) {
        process.stderr.write(`${JSON.stringify(error.failures, null, 2)}\n`);
      }
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
