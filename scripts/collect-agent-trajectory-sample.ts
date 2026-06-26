#!/usr/bin/env npx tsx

import { copyFile, mkdir, mkdtemp, stat, writeFile } from 'fs/promises';
import { homedir, tmpdir } from 'os';
import path from 'path';
import process from 'process';

import type { AgentTrajectoryAuditItem } from '../src/host/evaluation/trajectory/trajectoryExporter';

const MARKER = 'AGENT_TRAJECTORY_COLLECTION_SAMPLE';

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = 'production';
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function readFlagValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const inline = process.argv.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  return undefined;
}

function readCount(): number {
  const value = Number(readFlagValue('--count') ?? 20);
  if (!Number.isFinite(value) || value < 1 || value > 50) {
    throw new Error('--count must be between 1 and 50');
  }
  return Math.floor(value);
}

function defaultDataDir(): string {
  if (process.env.CODE_AGENT_DATA_DIR?.trim()) {
    return process.env.CODE_AGENT_DATA_DIR.trim();
  }
  if (process.platform === 'darwin') {
    return path.join(homedir(), 'Library', 'Application Support', 'code-agent');
  }
  return path.join(homedir(), '.code-agent');
}

function asJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function fail(message: string, details?: unknown): never {
  const suffix = details === undefined ? '' : `\n${asJson(details)}`;
  throw new Error(`${message}${suffix}`);
}

function reviewItem(item: AgentTrajectoryAuditItem): Record<string, unknown> {
  return {
    sessionId: item.sessionId,
    reviewScope: item.datasetRole === 'excluded' ? 'excluded_control' : 'agent_candidate',
    currentDatasetRole: item.datasetRole,
    suggestedAction: item.datasetRole === 'core_eval' ? 'verify_core_eval' : 'review_diagnostic',
    priority: item.datasetRole === 'core_eval' ? 'medium' : 'high',
    tier: item.tier,
    taskKind: item.taskKind,
    datasetVersion: item.datasetVersion,
    collectionSource: item.collectionSource,
    failures: item.failures.slice(0, 8),
    metrics: item.metrics,
    review: {
      datasetRole: null,
      taskKind: null,
      reviewedBy: null,
      notes: null,
      instruction: `Open Replay, then fill datasetRole. Gate suggestion: ${item.datasetRole}. Allowed: core_eval, diagnostic, excluded.`,
    },
  };
}

async function copyIfExists(source: string, target: string): Promise<boolean> {
  try {
    await stat(source);
  } catch {
    return false;
  }
  await copyFile(source, target);
  return true;
}

async function backupDataDirIfNeeded(
  dataDir: string,
  enabled: boolean,
  backupDir?: string,
): Promise<{ dir: string; files: string[] } | undefined> {
  if (!enabled) return undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetDir = path.resolve(
    backupDir || path.join(dataDir, 'backups', 'agent-trajectory-collection-sample', stamp),
  );
  await mkdir(targetDir, { recursive: true });
  const copied: string[] = [];
  const sourceDb = path.join(dataDir, 'code-agent.db');
  for (const suffix of ['', '-wal', '-shm']) {
    const fileName = `code-agent.db${suffix}`;
    if (await copyIfExists(`${sourceDb}${suffix}`, path.join(targetDir, fileName))) {
      copied.push(fileName);
    }
  }
  return copied.length > 0 ? { dir: targetDir, files: copied } : undefined;
}

async function main(): Promise<void> {
  const json = hasFlag('--json');
  const count = readCount();
  const repoRoot = process.cwd();
  const liveDataDir = hasFlag('--live-data-dir');
  const defaultLiveDataDir = path.resolve(defaultDataDir());
  const dataDirFlag = readFlagValue('--data-dir');
  const dataDir = path.resolve(
    dataDirFlag ?? (liveDataDir ? defaultLiveDataDir : await mkdtemp(path.join(tmpdir(), 'agent-trajectory-collection-sample-'))),
  );
  const writesLiveDataDir = dataDir === defaultLiveDataDir;
  const backupLiveDb = hasFlag('--backup-live-db');
  const liveDbBackupDir = readFlagValue('--live-db-backup-dir');
  if (writesLiveDataDir && !backupLiveDb) {
    throw new Error('Collecting into the live data dir requires --backup-live-db.');
  }
  const liveDbBackup = await backupDataDirIfNeeded(dataDir, backupLiveDb, liveDbBackupDir);
  const scratchDir = writesLiveDataDir
    ? await mkdtemp(path.join(tmpdir(), 'agent-trajectory-collection-run-'))
    : dataDir;
  const workspaceDir = path.resolve(
    readFlagValue('--workspace-dir') ??
      path.join(scratchDir, 'workspace'),
  );
  const testCaseDir = path.join(scratchDir, 'test-cases');
  const resultsDir = path.join(scratchDir, 'test-results');
  const outputDir = path.resolve(
    readFlagValue('--out-dir') ??
      (writesLiveDataDir
        ? path.join(repoRoot, 'eval-datasets', 'agent-trajectory', 'live-collection-sample-latest')
        : path.join(dataDir, 'eval-datasets', 'agent-trajectory')),
  );
  const fixturePath = path.join(workspaceDir, 'collection-sample-target.txt');
  const draftCoreEvalPath = path.join(outputDir, 'draft-core-eval-candidates.jsonl');
  const reviewManifestPath = path.join(outputDir, 'fresh-sample-review.json');

  await mkdir(workspaceDir, { recursive: true });
  await mkdir(testCaseDir, { recursive: true });
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    fixturePath,
    [`${MARKER}=true`, 'This fixture is used only to collect controlled real AgentLoop sessions.'].join('\n'),
    'utf8',
  );

  await writeFile(
    path.join(testCaseDir, 'agent-trajectory-collection-sample.yaml'),
    asJson({
      name: 'agent-trajectory-collection-sample',
      description: 'Controlled real AgentLoop sessions for Agent Trajectory P3 collection.',
      default_timeout: 30000,
      cases: Array.from({ length: count }, (_, index) => ({
        id: `agent-trajectory-collection-${String(index + 1).padStart(2, '0')}`,
        type: 'task',
        description: `Controlled Agent Trajectory collection sample ${index + 1}`,
        prompt: `Use the Read tool to inspect ${fixturePath}, then report the marker exactly. Collection sample #${index + 1}.`,
        tags: ['real-agent-run', 'agent-trajectory-collection-sample'],
        timeout: 30000,
        expect: {
          tool: 'Read',
          success: true,
          args_match: {
            file_path: fixturePath,
          },
          output_contains: [MARKER],
          response_contains: ['E2E real agent replay eval smoke completed'],
          min_tool_calls: 1,
          max_tool_calls: 1,
          max_turns: 3,
        },
      })),
    }),
    'utf8',
  );

  process.env.CODE_AGENT_DATA_DIR = dataDir;
  process.env.CODE_AGENT_E2E = '1';
  process.env.CODE_AGENT_E2E_LOCAL_AGENT_MODEL = '1';
  process.env.CODE_AGENT_E2E_AGENT_MODEL_READ_FILE = fixturePath;
  process.env.CODE_AGENT_MODEL_ENGINE = 'legacy';
  process.env.CODE_AGENT_DISABLE_RECENT_CONVERSATIONS = 'true';

  const { getProtocolRegistry } = await import('../src/host/tools/protocolRegistry');
  getProtocolRegistry();

  const { getDatabase } = await import('../src/host/services/core/databaseService');
  const testing = await import('../src/host/testing/index');
  const { exportAgentTrajectories, writeAgentTrajectoryJsonl } =
    await import('../src/host/evaluation/trajectory/trajectoryExporter');

  await getDatabase().initialize();

  try {
    const config = testing.createDefaultConfig(repoRoot, {
      testCaseDir,
      resultsDir,
      workingDirectory: workspaceDir,
      defaultTimeout: 30000,
      stopOnFailure: true,
      verbose: false,
      parallel: false,
      maxParallel: 1,
      enableEvalCritic: false,
      toolMode: 'deferred',
    });

    const agent = new testing.StandaloneAgentAdapter({
      workingDirectory: workspaceDir,
      generation: 'agent-trajectory-collection-sample',
      modelConfig: {
        provider: 'openai',
        model: 'e2e-local-agent-model',
        apiKey: 'e2e-local',
      },
      toolMode: 'deferred',
    });

    const runner = new testing.TestRunner(config, agent);
    const runSummary = await runner.runAll();
    if (runSummary.total !== count || runSummary.passed !== count) {
      fail('Collection sample did not pass all real-agent cases.', {
        expected: count,
        total: runSummary.total,
        passed: runSummary.passed,
        failed: runSummary.failed,
        partial: runSummary.partial,
        firstFailure: runSummary.results.find((result) => result.status !== 'passed'),
      });
    }
    const telemetryFailures = runSummary.results.filter((result) => result.telemetryGate?.passed !== true);
    if (telemetryFailures.length > 0) {
      fail('Collection sample contains telemetry gate failures.', telemetryFailures);
    }

    const sessionIds = runSummary.results
      .map((result) => result.sessionId)
      .filter((sessionId): sessionId is string => Boolean(sessionId));
    const exported = await exportAgentTrajectories({
      sessionIds,
      minTier: 'G2',
      includeRejected: false,
      datasetVersion: 'agent-trajectory-v1',
      persistCollectionMetadata: true,
    });
    await writeAgentTrajectoryJsonl(draftCoreEvalPath, exported.trajectories);

    const topFailure = exported.failureCounts[0];
    const topFailureRate = topFailure && exported.totalSessions > 0 ? topFailure.count / exported.totalSessions : 0;
    const reviewManifest = {
      generatedAt: Date.now(),
      dataDir,
      scratchDir,
      workspaceDir,
      draftCoreEvalPath,
      totalSessions: exported.totalSessions,
      exported: exported.exported,
      byTier: exported.byTier,
      g2Rate: exported.g2Rate,
      byDatasetRole: exported.byDatasetRole,
      byTaskKind: exported.byTaskKind,
      byCollectionSource: exported.byCollectionSource,
      qualityGate: {
        passed:
          exported.totalSessions === count &&
          exported.exported === count &&
          exported.byDatasetRole.core_eval === count &&
          exported.g2Rate >= 0.7 &&
          (!topFailure || topFailureRate <= 0.2),
        minSessions: count,
        minG2Rate: 0.7,
        maxTopFailureRate: 0.2,
        topFailure,
        topFailureRate,
      },
      reviewItems: exported.audits.map(reviewItem),
    };
    await writeFile(reviewManifestPath, `${asJson(reviewManifest)}\n`, 'utf8');

    const output = {
      ok: reviewManifest.qualityGate.passed,
      dataDir,
      scratchDir,
      workspaceDir,
      outputDir,
      draftCoreEvalPath,
      reviewManifestPath,
      liveDataDir: writesLiveDataDir,
      liveDbBackup,
      count,
      totalSessions: exported.totalSessions,
      exported: exported.exported,
      byTier: exported.byTier,
      g2Rate: exported.g2Rate,
      byDatasetRole: exported.byDatasetRole,
      byCollectionSource: exported.byCollectionSource,
      reviewItems: reviewManifest.reviewItems.length,
      sessionIds,
    };

    if (json) {
      console.log(asJson(output));
    } else {
      console.log(`Agent trajectory collection sample: ${output.ok ? 'passed' : 'needs_review'}`);
      console.log(asJson(output));
    }
  } finally {
    getDatabase().close();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
