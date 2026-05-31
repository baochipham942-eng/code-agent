#!/usr/bin/env npx tsx

import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { access, mkdtemp, rm } from 'fs/promises';
import { constants } from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { setTimeout as delay } from 'timers/promises';

type ApiFailure = {
  error?: string | { message?: string };
};

type StartedServer = {
  baseUrl: string;
  token: string;
  child: ChildProcessWithoutNullStreams;
  output: () => string;
};

type WrappedResponse<T> = {
  success: boolean;
  data?: T;
  error?: { code?: string; message?: string };
};

type ReviewStatus = 'pending' | 'approved' | 'rejected';
type ReviewDecision = 'allow_release' | 'request_changes';

type ArtifactIssue = {
  issueId: string;
  artifactId: string;
  artifactKind: string;
  traceIdentity: {
    traceId: string;
    traceSource: 'session_replay';
    source: 'session_replay';
    sessionId: string;
    replayKey: string;
  };
  source: 'eval_gate' | 'artifact_verifier';
  code: string;
  severity: 'high' | 'critical';
  status: 'open' | 'in_progress' | 'dismissed';
  title: string;
  message: string;
  createdAt: number;
  updatedAt: number;
  repairInstruction?: string;
  evidenceRefs: Array<{
    evidenceId: string;
    kind: 'browser_probe' | 'console_error';
    ref: string;
    summary: string;
    sensitivity: 'metadata_only';
    createdAt: number;
  }>;
  adminReview?: {
    decision: ReviewDecision;
    reviewer: string;
    reviewedAt: number;
    note?: string;
    statusAfter: string;
  };
};

type AdminReviewQueueItem = {
  issueId: string;
  reviewStatus: ReviewStatus;
  reason: string;
  recommendedDecision: ReviewDecision;
  issueStatus: string;
};

async function ensureBuiltWebServer(): Promise<void> {
  try {
    await access(path.join(process.cwd(), 'dist', 'web', 'webServer.cjs'), constants.R_OK);
  } catch {
    throw new Error('dist/web/webServer.cjs is missing. Run npm run build:web before this smoke.');
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to allocate a local port')));
        return;
      }
      const port = address.port;
      server.close(() => resolve(port));
    });
  });
}

function extractStartupToken(output: string, port: number): string | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try {
      const parsed = JSON.parse(line) as { port?: unknown; token?: unknown };
      if (parsed.port === port && typeof parsed.token === 'string' && parsed.token.length > 0) {
        return parsed.token;
      }
    } catch {
      // Ignore non-startup JSON logs.
    }
  }
  return null;
}

async function waitForServer(server: StartedServer, port: number): Promise<void> {
  const deadline = Date.now() + 90_000;
  let lastError = '';

  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) {
      throw new Error(`webServer exited early with ${server.child.exitCode}\n${server.output()}`);
    }

    const token = extractStartupToken(server.output(), port);
    if (token) {
      server.token = token;
      try {
        const response = await fetch(`${server.baseUrl}/api/health`);
        const health = await response.json() as { status?: string };
        if (response.ok && health.status === 'ok') return;
        lastError = JSON.stringify(health);
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }
    }

    await delay(250);
  }

  throw new Error(`Timed out waiting for webServer. Last error: ${lastError}\n${server.output()}`);
}

async function startServer(dataDir: string): Promise<StartedServer> {
  const port = await getFreePort();
  const outputChunks: string[] = [];
  const child = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'web', 'webServer.cjs')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODE_AGENT_DATA_DIR: dataDir,
      CODE_AGENT_E2E: '1',
      CODE_AGENT_WORKING_DIR: process.cwd(),
      WEB_HOST: '127.0.0.1',
      WEB_PORT: String(port),
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: process.cwd(),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => outputChunks.push(String(chunk)));
  child.stderr.on('data', (chunk) => outputChunks.push(String(chunk)));

  const server: StartedServer = {
    baseUrl: `http://127.0.0.1:${port}`,
    token: '',
    child,
    output: () => outputChunks.join('').slice(-80_000),
  };

  try {
    await waitForServer(server, port);
    return server;
  } catch (error) {
    await stopServer(server).catch(() => undefined);
    throw error;
  }
}

async function stopServer(server: StartedServer): Promise<void> {
  if (server.child.exitCode !== null) return;

  server.child.kill('SIGTERM');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) return;
    await delay(100);
  }
  server.child.kill('SIGKILL');
}

function readError(payload: ApiFailure | WrappedResponse<unknown>): string | undefined {
  if ('error' in payload && typeof payload.error === 'string') return payload.error;
  return payload.error?.message;
}

async function requestJson<T>(
  server: StartedServer,
  method: 'GET' | 'POST',
  pathname: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${server.baseUrl}${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${server.token}`,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({})) as T & ApiFailure;
  if (!response.ok) {
    throw new Error(readError(payload) || `Request failed: ${response.status} ${method} ${pathname}`);
  }
  return payload;
}

function makeTraceIdentity(sessionId: string): ArtifactIssue['traceIdentity'] {
  return {
    traceId: `session:${sessionId}`,
    traceSource: 'session_replay',
    source: 'session_replay',
    sessionId,
    replayKey: sessionId,
  };
}

function makeIssue(issueId: string, severity: ArtifactIssue['severity']): ArtifactIssue {
  const sessionId = `review-queue-${issueId}`;
  const now = Date.now();
  return {
    issueId,
    artifactId: `artifact-${issueId}`,
    artifactKind: 'html_artifact',
    traceIdentity: makeTraceIdentity(sessionId),
    source: 'eval_gate',
    code: severity === 'critical' ? 'visual_regression' : 'console_error',
    severity,
    status: 'open',
    title: `${severity} artifact issue`,
    message: `Generated artifact has a ${severity} issue.`,
    createdAt: now,
    updatedAt: now,
    evidenceRefs: [{
      evidenceId: `evidence-${issueId}`,
      kind: severity === 'critical' ? 'browser_probe' : 'console_error',
      ref: `probe:${issueId}`,
      summary: `${severity} evidence captured during replay.`,
      sensitivity: 'metadata_only',
      createdAt: now,
    }],
  };
}

async function upsertIssue(server: StartedServer, issue: ArtifactIssue): Promise<ArtifactIssue> {
  const response = await requestJson<WrappedResponse<ArtifactIssue>>(
    server,
    'POST',
    '/api/admin/review-queue/issues',
    issue,
  );
  if (!response.success || response.data?.issueId !== issue.issueId) {
    throw new Error(`Issue upsert returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function listQueue(server: StartedServer, includeReviewed = false): Promise<AdminReviewQueueItem[]> {
  const response = await requestJson<WrappedResponse<AdminReviewQueueItem[]>>(
    server,
    'GET',
    `/api/admin/review-queue${includeReviewed ? '?includeReviewed=true' : ''}`,
  );
  if (!response.success || !Array.isArray(response.data)) {
    throw new Error(`Review queue list returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function decideIssue(
  server: StartedServer,
  issueId: string,
  decision: ReviewDecision,
): Promise<{ issue: ArtifactIssue; queueItem: AdminReviewQueueItem | null }> {
  const response = await requestJson<WrappedResponse<{ issue: ArtifactIssue; queueItem: AdminReviewQueueItem | null }>>(
    server,
    'POST',
    `/api/admin/review-queue/${encodeURIComponent(issueId)}/decision`,
    {
      decision,
      reviewer: 'acceptance-admin',
      note: decision === 'allow_release'
        ? 'Manual review approved release.'
        : 'Manual review requested changes before release.',
      repairInstruction: decision === 'request_changes' ? 'Create regression and fix artifact render path.' : undefined,
    },
  );
  if (!response.success || !response.data?.issue) {
    throw new Error(`Review decision returned unexpected payload: ${JSON.stringify(response)}`);
  }
  return response.data;
}

async function main(): Promise<void> {
  await ensureBuiltWebServer();
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-admin-review-queue-'));
  let server: StartedServer | null = null;

  try {
    server = await startServer(dataDir);
    const criticalIssue = await upsertIssue(server, makeIssue('critical-1', 'critical'));
    const highIssue = await upsertIssue(server, makeIssue('high-1', 'high'));

    const pending = await listQueue(server);
    const criticalPending = pending.find((item) => item.issueId === criticalIssue.issueId);
    const highPending = pending.find((item) => item.issueId === highIssue.issueId);
    if (!criticalPending || !highPending) {
      throw new Error(`Expected both issues in pending review queue: ${JSON.stringify(pending)}`);
    }
    if (
      criticalPending.reviewStatus !== 'pending'
      || highPending.reviewStatus !== 'pending'
      || criticalPending.recommendedDecision !== 'request_changes'
      || !criticalPending.reason.includes('critical severity')
    ) {
      throw new Error(`Pending review queue items lacked required disposition context: ${JSON.stringify(pending)}`);
    }

    const rejected = await decideIssue(server, criticalIssue.issueId, 'request_changes');
    if (rejected.issue.status !== 'in_progress' || rejected.queueItem?.reviewStatus !== 'rejected') {
      throw new Error(`Request-changes decision did not reject queue item: ${JSON.stringify(rejected)}`);
    }

    const approved = await decideIssue(server, highIssue.issueId, 'allow_release');
    if (approved.issue.status !== 'dismissed' || approved.queueItem?.reviewStatus !== 'approved') {
      throw new Error(`Allow-release decision did not approve queue item: ${JSON.stringify(approved)}`);
    }

    const remainingPending = await listQueue(server);
    if (remainingPending.length !== 0) {
      throw new Error(`Pending queue was not drained after admin decisions: ${JSON.stringify(remainingPending)}`);
    }

    const history = await listQueue(server, true);
    console.log(JSON.stringify({
      ok: true,
      dataDir,
      pendingBefore: pending.length,
      pendingAfter: remainingPending.length,
      decisions: {
        requestChanges: {
          issueId: rejected.issue.issueId,
          status: rejected.issue.status,
          reviewStatus: rejected.queueItem?.reviewStatus,
        },
        allowRelease: {
          issueId: approved.issue.issueId,
          status: approved.issue.status,
          reviewStatus: approved.queueItem?.reviewStatus,
        },
      },
      historyCount: history.length,
    }, null, 2));
  } finally {
    if (server) await stopServer(server);
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
