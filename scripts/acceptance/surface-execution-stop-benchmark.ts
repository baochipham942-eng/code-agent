import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../src/host/app/applicationRunRegistry.ts';
import {
  getManagedBrowserProviderAdapter,
  managedBrowserServiceKey,
  resetManagedBrowserProviderAdapterForTests,
  surfaceIdentityFromToolContext,
} from '../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter.ts';
import { browserPool } from '../../src/host/services/infra/browserPool.ts';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import { browserActionTool } from '../../src/host/tools/vision/browserAction.ts';
import type { ToolContext, ToolExecutionResult } from '../../src/host/tools/types.ts';
import {
  finishWithError,
  getNumberOption,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';
import { nearestRankPercentile } from './surface-execution-metrics.ts';

const DEFAULT_OUTPUT_DIR = 'docs/acceptance/surface-execution/stop-benchmark-current';
const DEFAULT_SAMPLES = 20;
const STOP_GATE_MS = 2_000;

interface StopSample {
  index: number;
  latencyMs: number;
  inFlightMutationRejected: boolean;
  postStopMutationRejected: boolean;
  cleanupReleased: boolean;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function usage(): void {
  console.log(`Surface Execution real Stop benchmark

Usage:
  npm run acceptance:surface-execution-stop-benchmark -- [options]

Options:
  --samples <count>   Independent real System Chrome samples. Default: ${DEFAULT_SAMPLES}.
  --out <directory>   Canonical proof directory. Default: ${DEFAULT_OUTPUT_DIR}.
  --visible           Show System Chrome windows.
  --json              Print the final proof JSON.
  --help              Show this help.

Each sample creates an owner-scoped Managed Browser Surface Session, starts a
slow real navigation, stops it, verifies the in-flight and post-stop mutations
are rejected, then checks browser resource cleanup before the next sample.`);
}

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url === '/slow') {
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>unexpected slow completion</title>');
      }, 10_000);
      request.once('close', () => clearTimeout(timer));
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end('<!doctype html><title>Stop benchmark ready</title><button id="mutate">mutate</button>');
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Stop benchmark fixture failed to bind.');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function toolContext(input: {
  conversationId: string;
  runId: string;
  agentId: string;
  callId: string;
}): ToolContext {
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: input.conversationId,
    runId: input.runId,
    turnId: `turn-${input.callId}`,
    agentId: input.agentId,
    currentToolCallId: input.callId,
    abortSignal: new AbortController().signal,
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: { ready: true },
    },
  };
}

async function execute(
  context: ToolContext,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return browserActionTool.execute(params, context);
}

async function sampleStop(index: number, baseUrl: string): Promise<StopSample> {
  resetManagedBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const conversationId = `surface-stop-benchmark-${index}`;
  const runId = `surface-stop-run-${index}`;
  const agentId = `surface-stop-agent-${index}`;
  const registry = getApplicationRunRegistry();
  registry.start({ runId, sessionId: conversationId, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getManagedBrowserProviderAdapter();
  const baseContext = { conversationId, runId, agentId };
  const identity = surfaceIdentityFromToolContext(toolContext({
    ...baseContext,
    callId: `stop-${index}-identity`,
  }));
  assert(identity, `Sample ${index} could not derive a Surface identity.`);
  let cleanupReleased = false;

  try {
    const prepared = await execute(toolContext({
      ...baseContext,
      callId: `stop-${index}-prepare`,
    }), {
      action: 'navigate',
      url: `${baseUrl}/ready`,
      engine: 'managed',
    });
    assert(prepared.success, `Sample ${index} preparation failed: ${prepared.error}`);
    const binding = adapter.getBinding(identity);
    assert(binding, `Sample ${index} Managed binding was unavailable.`);

    const slowMutation = execute(toolContext({
      ...baseContext,
      callId: `stop-${index}-slow`,
    }), {
      action: 'navigate',
      url: `${baseUrl}/slow`,
      engine: 'managed',
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
    const startedAt = performance.now();
    await runtime.controlConversation({
      conversationId,
      surfaceSessionId: binding.surfaceSessionId,
      action: 'stop',
      reason: `Real Stop benchmark sample ${index}`,
    });
    const latencyMs = Math.ceil(performance.now() - startedAt);
    const stopped = await Promise.race([
      slowMutation,
      new Promise<never>((_resolve, reject) => setTimeout(() => {
        reject(new Error(`Sample ${index} in-flight mutation did not settle within ${STOP_GATE_MS}ms.`));
      }, STOP_GATE_MS)),
    ]);
    const postStop = await execute(toolContext({
      ...baseContext,
      callId: `stop-${index}-post-stop`,
    }), { action: 'reload', engine: 'managed' });
    await runtime.endRun(identity);
    cleanupReleased = !adapter.getBinding(identity)
      && !browserPool.hasAgent(managedBrowserServiceKey(identity));
    return {
      index,
      latencyMs,
      inFlightMutationRejected: !stopped.success,
      postStopMutationRejected: !postStop.success,
      cleanupReleased,
    };
  } finally {
    if (!cleanupReleased) await runtime.endRun(identity).catch(() => undefined);
    registry.clear();
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const campaignProof = surfaceAcceptanceCampaignProofFields();
  const samplesCount = getNumberOption(args, 'samples') ?? DEFAULT_SAMPLES;
  assert(Number.isInteger(samplesCount) && samplesCount >= 20 && samplesCount <= 100,
    'Stop benchmark sample count must be an integer between 20 and 100.');
  const outputDir = resolve(getStringOption(args, 'out') || DEFAULT_OUTPUT_DIR);
  mkdirSync(outputDir, { recursive: true });
  process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';
  process.env.CODE_AGENT_BROWSER_VISIBLE = hasFlag(args, 'visible') ? '1' : '0';

  const fixture = await startFixtureServer();
  const startedAt = Date.now();
  try {
    const samples: StopSample[] = [];
    for (let index = 1; index <= samplesCount; index += 1) {
      samples.push(await sampleStop(index, fixture.baseUrl));
    }
    const latencies = samples.map((sample) => sample.latencyMs);
    const p50Ms = nearestRankPercentile(latencies, 0.5);
    const p95Ms = nearestRankPercentile(latencies, 0.95);
    const mutationViolations = samples.filter((sample) => (
      !sample.inFlightMutationRejected || !sample.postStopMutationRejected
    )).length;
    const cleanupFailures = samples.filter((sample) => !sample.cleanupReleased).length;
    assert(p95Ms < STOP_GATE_MS, `Stop p95 ${p95Ms}ms exceeded ${STOP_GATE_MS}ms.`);
    assert(mutationViolations === 0, `${mutationViolations} samples accepted a mutation after Stop.`);
    assert(cleanupFailures === 0, `${cleanupFailures} samples failed Managed browser cleanup.`);

    const proof = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      acceptance: 'surface-execution-real-stop-benchmark',
      startedAt: new Date(startedAt).toISOString(),
      finishedAt: new Date().toISOString(),
      worktree: process.cwd(),
      provider: 'system-chrome-cdp',
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      metrics: {
        sampleCount: samples.length,
        p50Ms,
        p95Ms,
        maxMs: Math.max(...latencies),
        gateMs: STOP_GATE_MS,
        mutationViolations,
        cleanupFailures,
      },
      assertions: {
        independentRealSamples: samples.length >= 20,
        stopP95BelowTwoSeconds: p95Ms < STOP_GATE_MS,
        noPostStopMutation: mutationViolations === 0,
        cleanupReleasedEverySample: cleanupFailures === 0,
      },
      samples,
    };
    const proofPath = join(outputDir, 'proof.json');
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    if (hasFlag(args, 'json')) printJson(proof);
    else printKeyValue('Surface Execution Stop benchmark', [
      ['ok', true],
      ['samples', samples.length],
      ['p50Ms', p50Ms],
      ['p95Ms', p95Ms],
      ['mutationViolations', mutationViolations],
      ['cleanupFailures', cleanupFailures],
      ['proofPath', proofPath],
    ]);
  } finally {
    await closeServer(fixture.server);
  }
}

main().catch(finishWithError);
