import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrowserDomSnapshot } from '../../src/host/services/infra/browserService.ts';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../src/host/app/applicationRunRegistry.ts';
import {
  getManagedBrowserProviderAdapter,
  resetManagedBrowserProviderAdapterForTests,
  surfaceIdentityFromToolContext,
} from '../../src/host/services/surfaceExecution/ManagedBrowserProviderAdapter.ts';
import {
  getSurfaceExecutionRuntime,
  resetSurfaceExecutionRuntimeForTests,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import { browserActionTool } from '../../src/host/tools/vision/browserAction.ts';
import type {
  ToolContext,
  ToolExecutionResult,
} from '../../src/host/tools/types.ts';
import type {
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
} from '../../src/shared/contract/surfaceExecution.ts';
import {
  finishWithError,
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

const CONVERSATION_ID = 'surface-managed-acceptance';
const RUN_ID = 'surface-managed-run';
const AGENT_IDS = ['agent-alpha', 'agent-beta', 'agent-gamma'] as const;
const CANARY = 'surface-secret-canary-managed-e2e';
const STOP_GATE_MS = 2_000;

interface AgentHarness {
  agentId: typeof AGENT_IDS[number];
  events: SurfaceExecutionEventV1[];
  sequence: number;
}

interface AgentEvidence {
  agentId: string;
  surfaceSessionId: string;
  provider: string;
  initialTargetRef: string;
  businessReadback: string;
  screenshotPath: string;
  screenshotSha256: string;
  screenshotBytes: number;
}

function usage(): void {
  console.log(`Surface Execution Managed acceptance

Usage:
  npm run acceptance:surface-execution-managed -- [options]

Options:
  --visible         Launch isolated System Chrome windows visibly.
  --out <directory> Persist proof JSON and current-run screenshots.
  --json            Print JSON only.
  --help            Show this help.

Validates three real isolated Managed Browser Surface Sessions, business
readback after mutation, cross-agent target blocking, takeover/resume, stop
latency, no post-stop mutation, redaction canary safety, and cleanup.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function gitSha(ref: string): string {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function safeAgentId(pathname: string): typeof AGENT_IDS[number] | null {
  const candidate = pathname.split('/').filter(Boolean).at(-1);
  return AGENT_IDS.find((agentId) => agentId === candidate) ?? null;
}

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    if (request.url?.startsWith('/slow')) {
      const timer = setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><title>Slow mutation finished</title>');
      }, 10_000);
      request.once('close', () => clearTimeout(timer));
      return;
    }

    const agentId = safeAgentId(request.url || '');
    if (!agentId) {
      response.writeHead(404).end('not found');
      return;
    }
    const html = `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Surface ${agentId}</title></head>
  <body data-agent="${agentId}">
    <main>
      <h1>Managed Surface ${agentId}</h1>
      <label>Secret <input id="secret" type="password" autocomplete="off"></label>
      <button id="commit" onclick="document.querySelector('#status').textContent='Completed ${agentId}'; document.body.dataset.completed='yes'">Commit</button>
      <p id="status">Waiting ${agentId}</p>
    </main>
  </body>
</html>`;
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(html);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Fixture server did not bind a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function createHarness(agentId: typeof AGENT_IDS[number]): AgentHarness {
  return { agentId, events: [], sequence: 0 };
}

function contextFor(harness: AgentHarness, label: string): ToolContext {
  harness.sequence += 1;
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: `turn-${harness.agentId}`,
    agentId: harness.agentId,
    currentToolCallId: `${harness.agentId}:${label}:${harness.sequence}`,
    abortSignal: new AbortController().signal,
    requestPermission: async () => true,
    executionIntent: {
      browserSessionMode: 'managed',
      preferBrowserSession: true,
      allowBrowserAutomation: true,
      browserSessionSnapshot: { ready: true },
    },
    emit(type, data) {
      if (type === 'surface_execution') harness.events.push(data as SurfaceExecutionEventV1);
    },
  };
}

async function execute(
  harness: AgentHarness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return browserActionTool.execute(params, contextFor(harness, label));
}

async function requireSuccess(
  harness: AgentHarness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const result = await execute(harness, label, params);
  if (!result.success) throw new Error(`${harness.agentId} ${label} failed: ${result.error}`);
  return result;
}

function domSnapshot(result: ToolExecutionResult): BrowserDomSnapshot {
  const snapshot = result.metadata?.domSnapshot as BrowserDomSnapshot | undefined;
  assert(snapshot, 'Browser result did not include a DOM snapshot');
  return snapshot;
}

function targetRef(snapshot: BrowserDomSnapshot, selectorHint: string) {
  const element = snapshot.interactiveElements.find((candidate) => (
    candidate.selectorHint === selectorHint
  ));
  assert(element, `DOM snapshot did not include ${selectorHint}; available=${snapshot.interactiveElements
    .map((candidate) => `${candidate.tag}:${candidate.selectorHint}`)
    .join(',') || 'none'}`);
  return element.targetRef;
}

function surfaceSession(result: ToolExecutionResult) {
  const session = result.metadata?.surfaceExecutionSessionV1 as {
    sessionId?: string;
    provider?: string;
  } | undefined;
  assert(session?.sessionId, 'Result did not include a Surface Session identity');
  return { sessionId: session.sessionId, provider: session.provider || 'unknown' };
}

function copyScreenshot(source: string, outputDir: string, agentId: string): AgentEvidence['screenshotPath'] {
  assert(statSync(source).isFile(), `Screenshot is missing: ${source}`);
  const target = join(outputDir, `${agentId}.png`);
  copyFileSync(source, target);
  return target;
}

function withoutCanary(value: unknown, label: string): void {
  assert(!JSON.stringify(value).includes(CANARY), `${label} leaked the redaction canary`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const campaignProof = surfaceAcceptanceCampaignProofFields();

  process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';
  process.env.CODE_AGENT_BROWSER_VISIBLE = hasFlag(args, 'visible') ? '1' : '0';
  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-managed-proof-')));
  mkdirSync(outputDir, { recursive: true });

  resetManagedBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const registry = getApplicationRunRegistry();
  registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getManagedBrowserProviderAdapter();
  const fixture = await startFixtureServer();
  const harnesses = AGENT_IDS.map(createHarness);
  const evidence: AgentEvidence[] = [];
  let cleanupVerified = false;

  try {
    for (const harness of harnesses) {
      await requireSuccess(harness, 'navigate', {
        action: 'navigate',
        url: `${fixture.baseUrl}/${harness.agentId}`,
        engine: 'managed',
      });
    }

    const directSnapshots = await Promise.all(harnesses.map((harness) => (
      adapter.getBrowserService({
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        agentId: harness.agentId,
      }).getDomSnapshot()
    )));
    for (const [index, snapshot] of directSnapshots.entries()) {
      assert(
        snapshot.interactiveElements.length >= 2,
        `${harnesses[index].agentId} direct DOM preflight returned no interactive elements`,
      );
    }
    const initialSnapshots = await Promise.all(harnesses.map(async (harness) => (
      domSnapshot(await requireSuccess(harness, 'initial-dom', { action: 'get_dom_snapshot' }))
    )));
    const initialRefs = initialSnapshots.map((snapshot) => ({
      secret: targetRef(snapshot, '#secret'),
      commit: targetRef(snapshot, '#commit'),
    }));

    const typed = await requireSuccess(harnesses[0], 'type-canary', {
      action: 'type',
      targetRef: initialRefs[0].secret,
      text: CANARY,
    });
    withoutCanary(typed, 'Browser type result');
    const alphaPostTypeSnapshot = domSnapshot(await requireSuccess(
      harnesses[0],
      'post-type-dom',
      { action: 'get_dom_snapshot' },
    ));
    initialRefs[0].commit = targetRef(alphaPostTypeSnapshot, '#commit');

    await Promise.all(harnesses.map((harness, index) => requireSuccess(harness, 'commit', {
      action: 'click',
      targetRef: initialRefs[index].commit,
    })));

    for (const [index, harness] of harnesses.entries()) {
      const content = await requireSuccess(harness, 'business-readback', { action: 'get_content' });
      const expected = `Completed ${harness.agentId}`;
      assert(content.output?.includes(expected), `${harness.agentId} business readback missed ${expected}`);
      const screenshot = await requireSuccess(harness, 'screenshot', {
        action: 'screenshot',
        fullPage: true,
        analyze: false,
      });
      withoutCanary(screenshot.metadata, `${harness.agentId} screenshot metadata`);
      const sourcePath = String(screenshot.metadata?.path || '');
      const savedPath = copyScreenshot(sourcePath, outputDir, harness.agentId);
      const session = surfaceSession(screenshot);
      evidence.push({
        agentId: harness.agentId,
        surfaceSessionId: session.sessionId,
        provider: session.provider,
        initialTargetRef: initialRefs[index].commit.refId,
        businessReadback: expected,
        screenshotPath: savedPath,
        screenshotSha256: sha256(savedPath),
        screenshotBytes: statSync(savedPath).size,
      });
    }

    const crossAgent = await execute(harnesses[1], 'cross-agent-target', {
      action: 'click',
      targetRef: initialRefs[0].commit,
    });
    assert(!crossAgent.success, 'Cross-agent targetRef mutation unexpectedly succeeded');
    assert(
      [
        'SURFACE_ELEMENT_REF_NOT_FOUND',
        'SURFACE_STATE_STALE',
        'SURFACE_TARGET_REVISION_CHANGED',
        'BROWSER_TARGET_STALE',
      ]
        .includes(String(crossAgent.metadata?.code || crossAgent.metadata?.surfaceExecutionErrorV1
          && (crossAgent.metadata.surfaceExecutionErrorV1 as { code?: string }).code)),
      `Cross-agent targetRef failed without a stable stale/ownership code: ${crossAgent.error}`,
    );

    const alphaIdentity = surfaceIdentityFromToolContext(contextFor(harnesses[0], 'pause-identity'));
    assert(alphaIdentity, 'Alpha Surface identity was unavailable');
    const alphaBinding = adapter.getBinding(alphaIdentity);
    assert(alphaBinding, 'Alpha Managed binding was unavailable');
    const paused = await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: alphaBinding.surfaceSessionId,
      action: 'pause',
      reason: 'Managed acceptance independent pause',
    });
    assert(
      paused.snapshot.sessions.find((candidate) => (
        candidate.session.sessionId === alphaBinding.surfaceSessionId
      ))?.session.state === 'paused',
      'Pause did not transition the selected Browser Surface session',
    );
    const [blockedWhilePaused, betaWhileAlphaPaused, gammaWhileAlphaPaused] = await Promise.all([
      execute(harnesses[0], 'paused-reload-block', { action: 'reload' }),
      requireSuccess(harnesses[1], 'pause-isolation-beta', { action: 'get_content' }),
      requireSuccess(harnesses[2], 'pause-isolation-gamma', { action: 'get_content' }),
    ]);
    assert(!blockedWhilePaused.success, 'Paused Browser session accepted a new mutation');
    assert(
      betaWhileAlphaPaused.output?.includes('Completed agent-beta')
        && gammaWhileAlphaPaused.output?.includes('Completed agent-gamma'),
      'Pausing Alpha interrupted another concurrent Surface session',
    );
    const alphaResumed = await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: alphaBinding.surfaceSessionId,
      action: 'resume',
    });
    assert(
      alphaResumed.snapshot.sessions.find((candidate) => (
        candidate.session.sessionId === alphaBinding.surfaceSessionId
      ))?.session.state === 'running',
      'Pause resume did not restore the selected Browser Surface session',
    );

    const betaIdentity = surfaceIdentityFromToolContext(contextFor(harnesses[1], 'takeover-identity'));
    assert(betaIdentity, 'Beta Surface identity was unavailable');
    const betaBinding = adapter.getBinding(betaIdentity);
    assert(betaBinding, 'Beta Managed binding was unavailable');
    const takeover = await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: betaBinding.surfaceSessionId,
      action: 'takeover',
      reason: 'Managed acceptance takeover',
    });
    assert(takeover.requestId, 'Takeover did not return a request id');
    const blockedDuringTakeover = await execute(harnesses[1], 'takeover-block', {
      action: 'click',
      selector: '#commit',
    });
    assert(!blockedDuringTakeover.success, 'Browser mutation ran while human takeover was active');
    const resumed = await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: betaBinding.surfaceSessionId,
      action: 'resume',
    });
    assert(
      resumed.snapshot.sessions.find((candidate) => (
        candidate.session.sessionId === betaBinding.surfaceSessionId
      ))?.session.state === 'running',
      'Takeover resume did not restore the Browser Surface session',
    );

    const gammaIdentity = surfaceIdentityFromToolContext(contextFor(harnesses[2], 'stop-identity'));
    assert(gammaIdentity, 'Gamma Surface identity was unavailable');
    const gammaBinding = adapter.getBinding(gammaIdentity);
    assert(gammaBinding, 'Gamma Managed binding was unavailable');
    const slowMutation = execute(harnesses[2], 'slow-navigation', {
      action: 'navigate',
      url: `${fixture.baseUrl}/slow`,
    });
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 200));
    const stopStartedAt = Date.now();
    await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: gammaBinding.surfaceSessionId,
      action: 'stop',
      reason: 'Managed acceptance stop',
    });
    const stopLatencyMs = Date.now() - stopStartedAt;
    assert(stopLatencyMs < STOP_GATE_MS, `Stop latency ${stopLatencyMs}ms exceeded ${STOP_GATE_MS}ms`);
    const stoppedMutation = await Promise.race([
      slowMutation,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error(
        'Stopped Browser mutation did not settle within the gate',
      )), STOP_GATE_MS)),
    ]);
    assert(!stoppedMutation.success, 'In-flight Browser mutation succeeded after stop');
    const postStopMutation = await execute(harnesses[2], 'post-stop-mutation', {
      action: 'click',
      selector: '#commit',
    });
    assert(!postStopMutation.success, 'A new Browser mutation was accepted after stop');

    const snapshot = runtime.snapshotConversation(CONVERSATION_ID);
    assert(snapshot.sessions.length === 3, `Expected 3 Surface Sessions, got ${snapshot.sessions.length}`);
    const uniqueSessions = new Set(snapshot.sessions.map((candidate) => candidate.session.sessionId));
    const uniqueTargets = new Set(snapshot.sessions.map((candidate) => candidate.session.activeTarget
      && 'browserInstanceId' in candidate.session.activeTarget
      ? candidate.session.activeTarget.browserInstanceId
      : null));
    assert(uniqueSessions.size === 3, 'Concurrent sessions reused a Surface Session identity');
    assert(uniqueTargets.size === 3, 'Concurrent sessions reused a Managed browser identity');

    const surfaceEvents = harnesses.flatMap((harness) => harness.events);
    withoutCanary(surfaceEvents, 'Surface event stream');
    withoutCanary(snapshot, 'Surface snapshot');
    const cleanupIdentity = surfaceIdentityFromToolContext(contextFor(harnesses[0], 'cleanup-proof'));
    assert(cleanupIdentity, 'Cleanup Surface identity was unavailable');
    await runtime.endRun(cleanupIdentity);
    cleanupVerified = AGENT_IDS.every((agentId) => (
      !adapter.getBrowserService({ ...cleanupIdentity, agentId }).isRunning()
    ));
    assert(cleanupVerified, 'Managed browser cleanup did not release all three sessions');
    const finalSnapshot = runtime.snapshotConversation(CONVERSATION_ID);
    const proof = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      recordedAt: new Date().toISOString(),
      worktree: process.cwd(),
      head: gitSha('HEAD'),
      originMain: gitSha('origin/main'),
      mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim(),
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      fixtureOrigin: fixture.baseUrl,
      provider: 'system-chrome-cdp',
      assertions: {
        threeConcurrentSessions: true,
        isolatedBrowserIdentities: true,
        businessReadback: true,
        crossAgentTargetBlocked: true,
        independentPause: true,
        pauseResume: true,
        takeoverBlockedMutation: true,
        takeoverResume: true,
        stopLatencyBelowTwoSeconds: true,
        stoppedMutationSettled: true,
        noPostStopMutation: true,
        redactionCanaryAbsent: true,
        cleanupReleasedAllSessions: true,
      },
      stopLatencyMs,
      evidence,
      eventCount: surfaceEvents.length,
      sessions: finalSnapshot.sessions.map((candidate: SurfaceSessionProjectionV1) => ({
        session: candidate.session,
        eventCount: candidate.events.length,
        eventStatuses: candidate.events.map((event) => ({
          sequence: event.sequence,
          phase: event.phase,
          status: event.status,
          userSummary: event.userSummary,
        })),
      })),
    };
    withoutCanary(proof, 'Acceptance proof');
    const proofPath = join(outputDir, 'proof.json');
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');

    if (hasFlag(args, 'json')) printJson({ ok: true, outputDir, proofPath, ...proof.assertions });
    else printKeyValue('Surface Execution Managed Acceptance', [
      ['ok', true],
      ['sessions', snapshot.sessions.length],
      ['events', surfaceEvents.length],
      ['stopLatencyMs', stopLatencyMs],
      ['outputDir', outputDir],
      ['proofPath', proofPath],
    ]);
  } finally {
    const firstIdentity = surfaceIdentityFromToolContext(contextFor(harnesses[0], 'cleanup-finally'));
    if (!cleanupVerified && firstIdentity) {
      await runtime.endRun(firstIdentity).catch(() => undefined);
    }
    await closeServer(fixture.server);
    registry.clear();
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  }
}

main().catch(finishWithError);
