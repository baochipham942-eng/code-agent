#!/usr/bin/env npx tsx

import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import process from 'process';

import type { AgentTrajectoryAuditItem } from '../../src/host/evaluation/trajectory/trajectoryExporter';
import { applyAgentTrajectoryReviewManifest } from '../apply-agent-trajectory-review';

const MARKER = 'E2E_REAL_AGENT_REPLAY_EVAL_FIXTURE';

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
      instruction: `Fill datasetRole after Replay review. Gate suggestion: ${item.datasetRole}. Allowed: core_eval, diagnostic, excluded. Fill taskKind only when overriding ${item.taskKind}.`,
    },
  };
}

function reviewedItem(item: AgentTrajectoryAuditItem): Record<string, unknown> {
  return {
    ...reviewItem(item),
    review: {
      datasetRole: item.datasetRole,
      taskKind: item.taskKind,
      reviewedBy: 'acceptance-smoke',
      notes: 'Controlled P3 acceptance decision after real AgentLoop replay verification.',
    },
  };
}

async function main(): Promise<void> {
  const json = hasFlag('--json');
  const keepTmp = hasFlag('--keep-tmp') || process.env.CODE_AGENT_ACCEPTANCE_KEEP_TMP === '1';
  const count = readCount();
  const repoRoot = process.cwd();
  const dataDir = await mkdtemp(path.join(tmpdir(), 'agent-trajectory-fresh-sample-'));
  const workspaceDir = path.join(dataDir, 'workspace');
  const testCaseDir = path.join(dataDir, 'test-cases');
  const resultsDir = path.join(dataDir, 'test-results');
  const outputDir = path.join(dataDir, 'eval-datasets', 'agent-trajectory');
  const fixturePath = path.join(workspaceDir, 'fresh-sample-target.txt');
  const coreEvalPath = path.join(outputDir, 'core-eval.jsonl');
  const reviewManifestPath = path.join(outputDir, 'fresh-sample-review.json');
  const reviewedManifestPath = path.join(outputDir, 'fresh-sample-review-reviewed.json');

  try {
    await mkdir(workspaceDir, { recursive: true });
    await mkdir(testCaseDir, { recursive: true });
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      fixturePath,
      [`${MARKER}=true`, 'This fixture is shared by the fresh-sample acceptance batch.'].join('\n'),
      'utf8',
    );

    await writeFile(
      path.join(testCaseDir, 'agent-trajectory-fresh-sample.yaml'),
      asJson({
        name: 'agent-trajectory-fresh-sample',
        description: 'Batch real AgentLoop sessions for Agent Trajectory fresh-sample gate.',
        default_timeout: 30000,
        cases: Array.from({ length: count }, (_, index) => ({
          id: `agent-trajectory-fresh-sample-${String(index + 1).padStart(2, '0')}`,
          type: 'task',
          description: `Fresh sample real-agent trajectory ${index + 1}`,
          prompt: `Use the Read tool to inspect ${fixturePath}, then report the marker exactly. Fresh sample #${index + 1}.`,
          tags: ['smoke', 'real-agent-run', 'agent-trajectory-fresh-sample'],
          timeout: 30000,
          expect: {
            tool: 'Read',
            success: true,
            args_match: {
              file_path: fixturePath,
            },
            output_contains: [MARKER],
            response_contains: ['E2E real agent replay eval smoke completed', MARKER],
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

    const { getProtocolRegistry } = await import('../../src/host/tools/protocolRegistry');
    getProtocolRegistry();

    const { getDatabase } = await import('../../src/host/services/core/databaseService');
    const testing = await import('../../src/host/testing/index');
    const { exportAgentTrajectories, writeAgentTrajectoryJsonl } =
      await import('../../src/host/evaluation/trajectory/trajectoryExporter');

    await getDatabase().initialize();

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
      generation: 'e2e-agent-trajectory-fresh-sample',
      modelConfig: {
        provider: 'openai',
        model: 'e2e-local-agent-model',
        apiKey: 'e2e-local',
      },
      toolMode: 'deferred',
    });

    const runner = new testing.TestRunner(config, agent);
    const summary = await runner.runAll();
    if (summary.total !== count || summary.passed !== count) {
      fail('Fresh sample batch did not pass all real-agent cases.', {
        expected: count,
        total: summary.total,
        passed: summary.passed,
        failed: summary.failed,
        partial: summary.partial,
        firstFailure: summary.results.find((result) => result.status !== 'passed'),
      });
    }
    const telemetryFailures = summary.results.filter((result) => result.telemetryGate?.passed !== true);
    if (telemetryFailures.length > 0) {
      fail('Fresh sample batch contains telemetry gate failures.', telemetryFailures);
    }

    const exported = await exportAgentTrajectories({
      limit: count,
      minTier: 'G2',
      includeRejected: false,
      datasetVersion: 'agent-trajectory-v1',
      persistCollectionMetadata: true,
    });
    await writeAgentTrajectoryJsonl(coreEvalPath, exported.trajectories);

    const topFailure = exported.failureCounts[0];
    const topFailureRate = topFailure && exported.totalSessions > 0 ? topFailure.count / exported.totalSessions : 0;
    const gateFailures: string[] = [];
    if (exported.totalSessions < count) gateFailures.push(`session_count_below_${count}`);
    if (exported.g2Rate < 0.7) gateFailures.push('g2_rate_below_0.7');
    if (topFailure && topFailureRate > 0.2) gateFailures.push('top_failure_rate_above_0.2');
    if (exported.exported !== count || exported.byDatasetRole.core_eval !== count) {
      gateFailures.push('core_eval_export_count_mismatch');
    }
    if (gateFailures.length > 0) {
      fail('Fresh sample trajectory gate failed.', {
        gateFailures,
        totalSessions: exported.totalSessions,
        exported: exported.exported,
        byTier: exported.byTier,
        g2Rate: exported.g2Rate,
        byDatasetRole: exported.byDatasetRole,
        topFailure,
        topFailureRate,
      });
    }

    const reviewManifest = {
      generatedAt: Date.now(),
      dataDir: keepTmp ? dataDir : undefined,
      coreEvalPath,
      totalSessions: exported.totalSessions,
      exported: exported.exported,
      byTier: exported.byTier,
      g2Rate: exported.g2Rate,
      byDatasetRole: exported.byDatasetRole,
      byTaskKind: exported.byTaskKind,
      qualityGate: {
        passed: true,
        minSessions: count,
        minG2Rate: 0.7,
        maxTopFailureRate: 0.2,
        topFailure,
        topFailureRate,
      },
      reviewItems: exported.audits.map(reviewItem),
    };
    await writeFile(reviewManifestPath, `${asJson(reviewManifest)}\n`, 'utf8');

    const reviewedManifest = {
      ...reviewManifest,
      reviewItems: exported.audits.map(reviewedItem),
    };
    await writeFile(reviewedManifestPath, `${asJson(reviewedManifest)}\n`, 'utf8');

    const reviewApply = await applyAgentTrajectoryReviewManifest({
      dataDir,
      liveDataDir: true,
      keepTmp: true,
      apply: true,
      manifestPath: reviewedManifestPath,
      reviewer: 'acceptance-smoke',
      json: false,
    });
    if (!reviewApply.ok || reviewApply.applied !== count || reviewApply.skipped !== 0) {
      fail('Fresh sample review apply did not persist all controlled review decisions.', reviewApply);
    }

    await getDatabase().initialize();
    const reviewedExport = await exportAgentTrajectories({
      limit: count,
      minTier: 'G2',
      includeRejected: false,
      datasetVersion: 'agent-trajectory-v1',
      persistCollectionMetadata: false,
    });
    const manualReviewed = reviewedExport.byCollectionSource.manual_review ?? 0;
    const manualReviewedAgentCandidates = reviewedExport.audits.filter(
      (item) =>
        item.collectionSource === 'manual_review' &&
        (item.datasetRole === 'core_eval' || item.datasetRole === 'diagnostic'),
    ).length;
    const pendingReview = Math.max(0, reviewedExport.totalSessions - manualReviewed);
    const pendingAgentCandidateReview = Math.max(
      0,
      (reviewedExport.byDatasetRole.core_eval ?? 0) +
        (reviewedExport.byDatasetRole.diagnostic ?? 0) -
        manualReviewedAgentCandidates,
    );
    const reviewedTopFailure = reviewedExport.failureCounts[0];
    const reviewedTopFailureRate =
      reviewedTopFailure && reviewedExport.totalSessions > 0
        ? reviewedTopFailure.count / reviewedExport.totalSessions
        : 0;
    const closeoutFailures: string[] = [];
    if (reviewedExport.totalSessions < count) closeoutFailures.push(`session_count_below_${count}`);
    if ((reviewedExport.byDatasetRole.core_eval ?? 0) + (reviewedExport.byDatasetRole.diagnostic ?? 0) < count) {
      closeoutFailures.push(`agent_candidate_count_below_${count}`);
    }
    if (reviewedExport.exported !== count) closeoutFailures.push(`exported_count_below_${count}`);
    if (manualReviewed < count) closeoutFailures.push(`manual_reviewed_count_below_${count}`);
    if (manualReviewedAgentCandidates < count) {
      closeoutFailures.push(`manual_reviewed_agent_candidate_count_below_${count}`);
    }
    if (pendingReview !== 0) closeoutFailures.push('pending_review_above_0');
    if (pendingAgentCandidateReview !== 0) closeoutFailures.push('pending_agent_candidate_review_above_0');
    if (reviewedExport.g2Rate < 0.7) closeoutFailures.push('g2_rate_below_0.7');
    if (reviewedTopFailure && reviewedTopFailureRate > 0.2) closeoutFailures.push('top_failure_rate_above_0.2');
    if (closeoutFailures.length > 0) {
      fail('Fresh sample controlled P3 closeout failed after review apply.', {
        closeoutFailures,
        totalSessions: reviewedExport.totalSessions,
        exported: reviewedExport.exported,
        byTier: reviewedExport.byTier,
        g2Rate: reviewedExport.g2Rate,
        byDatasetRole: reviewedExport.byDatasetRole,
        byCollectionSource: reviewedExport.byCollectionSource,
        manualReviewed,
        manualReviewedAgentCandidates,
        pendingReview,
        pendingAgentCandidateReview,
        reviewedTopFailure,
        reviewedTopFailureRate,
      });
    }

    const output = {
      ok: true,
      dataDir: keepTmp ? dataDir : undefined,
      count,
      coreEvalPath,
      reviewManifestPath,
      reviewedManifestPath,
      totalSessions: exported.totalSessions,
      exported: exported.exported,
      byTier: exported.byTier,
      g2Rate: exported.g2Rate,
      byDatasetRole: exported.byDatasetRole,
      reviewItems: reviewManifest.reviewItems.length,
      reviewApply: {
        applied: reviewApply.applied,
        skipped: reviewApply.skipped,
        copiedDataDir: reviewApply.copiedDataDir,
      },
      reviewedCloseout: {
        totalSessions: reviewedExport.totalSessions,
        exported: reviewedExport.exported,
        byTier: reviewedExport.byTier,
        g2Rate: reviewedExport.g2Rate,
        byDatasetRole: reviewedExport.byDatasetRole,
        byCollectionSource: reviewedExport.byCollectionSource,
        manualReviewed,
        manualReviewedAgentCandidates,
        pendingReview,
        pendingAgentCandidateReview,
        topFailure: reviewedTopFailure,
        topFailureRate: reviewedTopFailureRate,
      },
      sessionIds: summary.results.map((result) => result.sessionId),
    };

    if (json) {
      console.log(asJson(output));
    } else {
      console.log('Agent trajectory fresh-sample smoke passed');
      console.log(asJson(output));
    }
  } finally {
    if (!keepTmp) {
      await rm(dataDir, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
