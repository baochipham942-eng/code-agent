import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import sharp from 'sharp';
import type { BrowserDomSnapshot } from '../../src/host/services/infra/browserService.ts';
import type { SessionWithMessages } from '../../src/host/services/infra/sessionManager.ts';
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
  type SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import {
  SURFACE_EXECUTION_LEDGER_METADATA_KEY,
  SurfaceConversationProjectionService,
} from '../../src/host/services/surfaceExecution/SurfaceConversationProjectionService.ts';
import { browserActionTool } from '../../src/host/tools/vision/browserAction.ts';
import type { ToolContext, ToolExecutionResult } from '../../src/host/tools/types.ts';
import type {
  SurfaceConversationSnapshotV1,
  SurfaceEvidenceCardV1,
  SurfaceExecutionEventV1,
  SurfaceSessionProjectionV1,
} from '../../src/shared/contract/surfaceExecution.ts';
import {
  getSystemChromeExecutable,
} from './browser-computer-system-chrome.ts';
import {
  finishWithError,
  getStringOption,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import {
  evaluateWorkBuddyBusinessReadback,
  renderWorkBuddyArtifact,
  type WorkBuddyBusinessEvaluation,
  type WorkBuddyArtifactStage,
} from './fixtures/surface-execution-workbuddy.ts';
import {
  surfaceAcceptanceCampaignProofFields,
  surfaceAcceptanceSourceFingerprint,
} from './surface-execution-proof.ts';

const CONVERSATION_ID = 'surface-workbuddy-acceptance';
const RUN_ID = 'surface-workbuddy-run';
const AGENT_ID = 'workbuddy-reviewer';
const TURN_ID = 'turn-workbuddy-visual-repair';
const PROVIDER = 'system-chrome-cdp';
const CANARY = 'surface-secret-canary-workbuddy-e2e';
const RED_PIXEL_GATE = 5_000;
const GREEN_PIXEL_GATE = 5_000;

interface HarnessResult {
  label: string;
  toolCallId: string;
  result: ToolExecutionResult;
}

interface WorkBuddyHarness {
  events: SurfaceExecutionEventV1[];
  results: HarnessResult[];
  sequence: number;
}

interface ScreenshotPixelSummary {
  width: number;
  height: number;
  redPixels: number;
  greenPixels: number;
  sampledPixels: number;
}

interface ScreenshotEvidence {
  path: string;
  sha256: string;
  bytes: number;
  pixels: ScreenshotPixelSummary;
  card: SurfaceEvidenceCardV1;
}

class AcceptanceProjectionStore {
  private readonly session: SessionWithMessages;

  constructor(now: number) {
    this.session = {
      id: CONVERSATION_ID,
      title: 'Surface WorkBuddy visual repair acceptance',
      modelConfig: { provider: 'openai', model: 'acceptance-local' },
      workingDirectory: process.cwd(),
      metadata: {},
      createdAt: now,
      updatedAt: now,
      messages: [],
      todos: [],
      messageCount: 0,
    } as SessionWithMessages;
  }

  appendToolResult(record: HarnessResult): void {
    this.session.messages.push({
      id: `message-${record.toolCallId}`,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolResults: [{
        toolCallId: record.toolCallId,
        success: record.result.success,
        ...(record.result.output ? { output: record.result.output } : {}),
        ...(record.result.error ? { error: record.result.error } : {}),
        ...(record.result.outputPath ? { outputPath: record.result.outputPath } : {}),
        ...(record.result.metadata ? { metadata: record.result.metadata } : {}),
      }],
    });
    this.session.messageCount = this.session.messages.length;
    this.session.updatedAt = Date.now();
  }

  appendSurfaceEvent(
    label: string,
    event: SurfaceExecutionEventV1,
    session?: unknown,
  ): void {
    this.session.messages.push({
      id: `message-${label}-${event.eventId}`,
      role: 'assistant',
      content: '',
      timestamp: event.completedAt || event.startedAt,
      toolResults: [{
        toolCallId: `${AGENT_ID}:${label}:${event.sequence}`,
        success: event.status === 'succeeded',
        metadata: {
          surfaceExecutionEventV1: structuredClone(event),
          surfaceExecutionEventsV1: [structuredClone(event)],
          ...(session ? { surfaceExecutionSessionV1: structuredClone(session) } : {}),
        },
      }],
    });
    this.session.messageCount = this.session.messages.length;
    this.session.updatedAt = Date.now();
  }

  async getSession(conversationId: string): Promise<SessionWithMessages | null> {
    return conversationId === CONVERSATION_ID ? this.session : null;
  }

  async patchSessionMetadata(
    conversationId: string,
    patch: Record<string, unknown>,
    options?: { updatedAt?: number },
  ): Promise<boolean> {
    if (conversationId !== CONVERSATION_ID) return false;
    this.session.metadata = { ...(this.session.metadata || {}), ...structuredClone(patch) };
    this.session.updatedAt = options?.updatedAt || Date.now();
    return true;
  }

  metadata(): Record<string, unknown> {
    return structuredClone(this.session.metadata || {});
  }
}

function usage(): void {
  console.log(`Surface Execution WorkBuddy-style Managed acceptance

Usage:
  npm run acceptance:surface-execution-workbuddy -- [options]

Options:
  --visible         Launch the isolated System Chrome window visibly.
  --out <directory> Persist current-run proof, screenshots, and artifacts.
  --json            Print JSON only.
  --help            Show this help.

Generates an intentionally failing HTML launch artifact, opens it in Managed
System Chrome, screenshots and reads the rendered result, records a failed
business judgment, repairs the artifact, reopens and reverifies it, then saves
the final artifact with Surface session/event/proof/conversation evidence.`);
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

function sha256Buffer(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Buffer(readFileSync(path));
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function acceptanceCommand(): string {
  return [
    'npm',
    'run',
    'acceptance:surface-execution-workbuddy',
    '--',
    ...process.argv.slice(2),
  ].map(shellQuote).join(' ');
}

function chromeVersion(executable: string): string {
  return execFileSync(executable, ['--version'], { encoding: 'utf8' }).trim();
}

function withoutCanary(value: unknown, label: string): void {
  assert(!JSON.stringify(value).includes(CANARY), `${label} leaked the redaction canary`);
}

function createHarness(): WorkBuddyHarness {
  return { events: [], results: [], sequence: 0 };
}

function contextFor(harness: WorkBuddyHarness, label: string): ToolContext {
  harness.sequence += 1;
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: TURN_ID,
    agentId: AGENT_ID,
    currentToolCallId: `${AGENT_ID}:${label}:${harness.sequence}`,
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
  harness: WorkBuddyHarness,
  store: AcceptanceProjectionStore,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const context = contextFor(harness, label);
  const result = await browserActionTool.execute(params, context);
  const record = {
    label,
    toolCallId: context.currentToolCallId as string,
    result,
  };
  harness.results.push(record);
  store.appendToolResult(record);
  return result;
}

async function requireSuccess(
  harness: WorkBuddyHarness,
  store: AcceptanceProjectionStore,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const result = await execute(harness, store, label, params);
  if (!result.success) throw new Error(`${label} failed: ${result.error}`);
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
  assert(element, `DOM snapshot did not include ${selectorHint}`);
  return element.targetRef;
}

function surfaceSession(result: ToolExecutionResult): { sessionId: string; provider: string } {
  const session = result.metadata?.surfaceExecutionSessionV1 as {
    sessionId?: string;
    provider?: string;
  } | undefined;
  assert(session?.sessionId, 'Browser result did not include a Surface session');
  return { sessionId: session.sessionId, provider: session.provider || 'unknown' };
}

function surfaceEvidenceCard(result: ToolExecutionResult): SurfaceEvidenceCardV1 {
  const card = result.metadata?.surfaceEvidenceCardV1 as SurfaceEvidenceCardV1 | undefined;
  assert(card?.version === 1, 'Browser screenshot did not include a Surface proof card');
  assert(card.kind === 'screenshot', `Expected screenshot proof, got ${card.kind}`);
  assert(card.source === 'browser', `Expected Browser proof, got ${card.source}`);
  assert(card.redactionStatus === 'clean', `Screenshot proof was not clean: ${card.redactionStatus}`);
  assert(card.inspection.captureState === 'captured', 'Screenshot proof did not capture evidence');
  return card;
}

function copyCurrentScreenshot(
  result: ToolExecutionResult,
  outputDir: string,
  filename: string,
  runStartedAt: number,
): string {
  const source = String(result.metadata?.path || '');
  assert(source, 'Browser screenshot result did not include a path');
  const sourceStat = statSync(source);
  assert(sourceStat.isFile(), `Browser screenshot is missing: ${source}`);
  assert(
    sourceStat.mtimeMs >= runStartedAt - 1_000,
    `Browser screenshot predates this acceptance run: ${source}`,
  );
  const target = join(outputDir, filename);
  copyFileSync(source, target);
  return target;
}

async function analyzeStatusPixels(path: string): Promise<ScreenshotPixelSummary> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let redPixels = 0;
  let greenPixels = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (red >= 175 && green <= 90 && blue <= 100) redPixels += 1;
    if (green >= 115 && red <= 90 && blue <= 135) greenPixels += 1;
  }
  return {
    width: info.width,
    height: info.height,
    redPixels,
    greenPixels,
    sampledPixels: info.width * info.height,
  };
}

function reviewedCard(input: {
  base: SurfaceEvidenceCardV1;
  filename: string;
  evaluation: WorkBuddyBusinessEvaluation;
  pixels: ScreenshotPixelSummary;
  expectedColor: 'red' | 'green';
}): SurfaceEvidenceCardV1 {
  const passed = input.evaluation.verdict === 'pass';
  const colorFinding = input.expectedColor === 'red'
    ? `Rendered failure banner: ${input.pixels.redPixels} red pixels.`
    : `Rendered success banner: ${input.pixels.greenPixels} green pixels.`;
  return {
    ...structuredClone(input.base),
    assetRef: `screenshot://surface-execution-workbuddy/${input.filename}`,
    summary: passed
      ? 'Rendered artifact passed the WorkBuddy business checklist after repair.'
      : 'Rendered artifact failed the WorkBuddy business checklist and required repair.',
    inspection: {
      ...structuredClone(input.base.inspection),
      analysisState: 'analyzed',
      verificationState: passed ? 'verified' : 'rejected',
      inspectedBy: {
        kind: 'service',
        id: 'surface-workbuddy-acceptance',
        method: 'vision',
      },
      inspectedAt: Date.now(),
      checklist: [
        ...input.evaluation.checks.map((check) => ({
          id: `business-${check.id}`,
          label: check.label,
          status: check.passed ? 'passed' as const : 'failed' as const,
          finding: `${check.observed}; expected ${check.expected}`,
        })),
        {
          id: 'rendered-status-color',
          label: 'Rendered status color',
          status: 'passed',
          finding: colorFinding,
        },
        {
          id: 'redaction-canary',
          label: 'Redaction canary',
          status: 'passed',
          finding: 'The raw canary is absent from projected evidence.',
        },
      ],
    },
  };
}

function publishBusinessReview(input: {
  runtime: SurfaceExecutionRuntime;
  identity: SurfaceRuntimeIdentityV1;
  card: SurfaceEvidenceCardV1;
  evaluation: WorkBuddyBusinessEvaluation;
  artifactRef: string;
  stage: WorkBuddyArtifactStage;
}): SurfaceExecutionEventV1 {
  const prepared = input.runtime.prepareBrowserSession({
    identity: input.identity,
    provider: PROVIDER,
  });
  assert(prepared.session.activeTarget, 'Surface session did not have an active Browser target');
  const passed = input.evaluation.verdict === 'pass';
  return input.runtime.events.publish(prepared.subject, {
    phase: 'verify',
    status: passed ? 'succeeded' : 'failed',
    userSummary: passed
      ? 'WorkBuddy repaired artifact passed rendered business verification'
      : 'WorkBuddy draft artifact failed rendered business verification',
    target: prepared.session.activeTarget,
    operation: {
      action: `workbuddy_business_review_${input.stage}`,
      risk: 'read-only evidence review',
      expectedOutcome: passed
        ? 'All four launch requirements pass'
        : 'The intentionally incomplete draft is rejected',
    },
    observation: {
      verdict: passed ? 'pass' : 'fail',
      findings: passed
        ? ['All four launch requirements passed after artifact repair.']
        : input.evaluation.findings,
      confidence: 1,
    },
    evidenceRefs: [input.card.evidenceId],
    evidence: [input.card],
    artifactRefs: [input.artifactRef],
    availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    completedAt: Date.now(),
  });
}

async function startArtifactServer(
  artifacts: Map<WorkBuddyArtifactStage, string>,
): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    if (url.pathname !== '/artifact') {
      response.writeHead(404).end('not found');
      return;
    }
    const stage = url.searchParams.get('stage');
    const path = stage === 'draft' || stage === 'final' ? artifacts.get(stage) : undefined;
    if (!path) {
      response.writeHead(404).end('artifact stage unavailable');
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
    });
    response.end(readFileSync(path, 'utf8'));
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Artifact server did not bind a TCP port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function listFilesRecursively(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFilesRecursively(root, path) : [path];
  });
}

function scanFilesForCanary(outputDir: string): string[] {
  const files = listFilesRecursively(outputDir);
  for (const path of files) {
    assert(!readFileSync(path).includes(Buffer.from(CANARY)), `Output file leaked the canary: ${path}`);
  }
  return files.map((path) => relative(outputDir, path)).sort();
}

function projectionFor(
  snapshot: SurfaceConversationSnapshotV1,
  surfaceSessionId: string,
): SurfaceSessionProjectionV1 {
  const projection = snapshot.sessions.find((candidate) => (
    candidate.session.sessionId === surfaceSessionId
  ));
  assert(projection, `Conversation projection missed Surface session ${surfaceSessionId}`);
  return projection;
}

function proofCardSummary(card: SurfaceEvidenceCardV1) {
  return {
    evidenceId: card.evidenceId,
    kind: card.kind,
    source: card.source,
    assetRef: card.assetRef,
    redactionStatus: card.redactionStatus,
    inspection: card.inspection,
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  const campaignProof = surfaceAcceptanceCampaignProofFields();
  const runStartedAt = Date.now();
  process.env.CODE_AGENT_BROWSER_PROVIDER = PROVIDER;
  process.env.CODE_AGENT_BROWSER_VISIBLE = hasFlag(args, 'visible') ? '1' : '0';
  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-workbuddy-proof-')));
  mkdirSync(outputDir, { recursive: true });
  const draftArtifactPath = join(outputDir, 'draft-artifact.html');
  const finalArtifactPath = join(outputDir, 'final-artifact.html');
  writeFileSync(draftArtifactPath, renderWorkBuddyArtifact('draft'), 'utf8');
  const artifacts = new Map<WorkBuddyArtifactStage, string>([['draft', draftArtifactPath]]);

  resetManagedBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const registry = getApplicationRunRegistry();
  registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getManagedBrowserProviderAdapter();
  const projectionStore = new AcceptanceProjectionStore(runStartedAt);
  const projectionService = new SurfaceConversationProjectionService({
    runtime,
    sessionStore: projectionStore,
  });
  const fixture = await startArtifactServer(artifacts);
  const harness = createHarness();
  const executable = getSystemChromeExecutable();
  const version = chromeVersion(executable);
  let cleanupVerified = false;
  let identity: SurfaceRuntimeIdentityV1 | null = null;

  try {
    const draftUrl = `${fixture.baseUrl}/artifact?stage=draft&run=${runStartedAt}`;
    const draftNavigate = await requireSuccess(harness, projectionStore, 'navigate-draft', {
      action: 'navigate',
      url: draftUrl,
      engine: 'managed',
    });
    const draftSession = surfaceSession(draftNavigate);
    assert(draftSession.provider === PROVIDER, `Managed provider mismatch: ${draftSession.provider}`);

    const draftDom = domSnapshot(await requireSuccess(
      harness,
      projectionStore,
      'observe-draft-dom',
      { action: 'get_dom_snapshot' },
    ));
    const releaseTokenRef = targetRef(draftDom, '#release-token');
    const typed = await requireSuccess(harness, projectionStore, 'type-redaction-canary', {
      action: 'type',
      targetRef: releaseTokenRef,
      text: CANARY,
    });
    withoutCanary(typed, 'Managed type result');

    const draftScreenshotResult = await requireSuccess(
      harness,
      projectionStore,
      'screenshot-draft',
      { action: 'screenshot', fullPage: true, analyze: false },
    );
    const draftScreenshotPath = copyCurrentScreenshot(
      draftScreenshotResult,
      outputDir,
      'before-failed.png',
      runStartedAt,
    );
    const draftReadbackResult = await requireSuccess(
      harness,
      projectionStore,
      'read-draft',
      { action: 'get_content' },
    );
    const draftReadback = draftReadbackResult.output || '';
    const draftPixels = await analyzeStatusPixels(draftScreenshotPath);
    const draftEvaluation = evaluateWorkBuddyBusinessReadback(draftReadback);
    assert(draftEvaluation.verdict === 'fail', 'Intentionally incomplete draft unexpectedly passed');
    assert(
      draftPixels.redPixels >= RED_PIXEL_GATE && draftPixels.redPixels > draftPixels.greenPixels,
      `Draft screenshot did not render the failure banner: ${JSON.stringify(draftPixels)}`,
    );
    const draftCard = reviewedCard({
      base: surfaceEvidenceCard(draftScreenshotResult),
      filename: basename(draftScreenshotPath),
      evaluation: draftEvaluation,
      pixels: draftPixels,
      expectedColor: 'red',
    });

    const identityContext = contextFor(harness, 'publish-business-review');
    identity = surfaceIdentityFromToolContext(identityContext);
    assert(identity, 'Managed Surface identity was unavailable');
    const draftReviewEvent = publishBusinessReview({
      runtime,
      identity,
      card: draftCard,
      evaluation: draftEvaluation,
      artifactRef: 'artifact://surface-execution-workbuddy/draft-artifact.html',
      stage: 'draft',
    });
    assert(draftReviewEvent.observation?.verdict === 'fail', 'Draft failure was not projected');
    projectionStore.appendSurfaceEvent('draft-business-review', draftReviewEvent);

    writeFileSync(finalArtifactPath, renderWorkBuddyArtifact('final'), 'utf8');
    artifacts.set('final', finalArtifactPath);
    const finalUrl = `${fixture.baseUrl}/artifact?stage=final&run=${runStartedAt}`;
    const finalNavigate = await requireSuccess(harness, projectionStore, 'navigate-final', {
      action: 'navigate',
      url: finalUrl,
      engine: 'managed',
    });
    assert(
      surfaceSession(finalNavigate).sessionId === draftSession.sessionId,
      'Artifact repair unexpectedly replaced the Surface session',
    );

    const finalScreenshotResult = await requireSuccess(
      harness,
      projectionStore,
      'screenshot-final',
      { action: 'screenshot', fullPage: true, analyze: false },
    );
    const finalScreenshotPath = copyCurrentScreenshot(
      finalScreenshotResult,
      outputDir,
      'after-fixed.png',
      runStartedAt,
    );
    const finalReadbackResult = await requireSuccess(
      harness,
      projectionStore,
      'read-final',
      { action: 'get_content' },
    );
    const finalReadback = finalReadbackResult.output || '';
    const finalPixels = await analyzeStatusPixels(finalScreenshotPath);
    const finalEvaluation = evaluateWorkBuddyBusinessReadback(finalReadback);
    assert(finalEvaluation.verdict === 'pass', `Repaired artifact failed: ${finalEvaluation.findings.join(' ')}`);
    assert(
      finalPixels.greenPixels >= GREEN_PIXEL_GATE && finalPixels.greenPixels > finalPixels.redPixels,
      `Final screenshot did not render the success banner: ${JSON.stringify(finalPixels)}`,
    );
    assert(
      sha256File(finalScreenshotPath) !== sha256File(draftScreenshotPath),
      'Before and after screenshots are identical',
    );
    assert(
      sha256File(finalArtifactPath) !== sha256File(draftArtifactPath),
      'Draft and final artifacts are identical',
    );
    const finalCard = reviewedCard({
      base: surfaceEvidenceCard(finalScreenshotResult),
      filename: basename(finalScreenshotPath),
      evaluation: finalEvaluation,
      pixels: finalPixels,
      expectedColor: 'green',
    });
    const finalReviewEvent = publishBusinessReview({
      runtime,
      identity,
      card: finalCard,
      evaluation: finalEvaluation,
      artifactRef: 'artifact://surface-execution-workbuddy/final-artifact.html',
      stage: 'final',
    });
    assert(finalReviewEvent.observation?.verdict === 'pass', 'Final pass was not projected');
    projectionStore.appendSurfaceEvent('final-business-review', finalReviewEvent);

    withoutCanary(harness.results, 'Tool result ledger');
    withoutCanary(harness.events, 'Surface event stream');
    await projectionService.flushPersistence(CONVERSATION_ID);
    const liveProjectionSnapshot = await projectionService.getSnapshot(CONVERSATION_ID);
    withoutCanary(liveProjectionSnapshot, 'Live conversation projection');
    const liveProjection = projectionFor(liveProjectionSnapshot, draftSession.sessionId);
    assert(
      liveProjection.events.some((event) => event.observation?.verdict === 'fail')
        && liveProjection.events.some((event) => event.observation?.verdict === 'pass'),
      'Conversation projection missed the fail-to-pass verification sequence',
    );
    assert(liveProjection.evidence.length >= 2, 'Conversation projection missed screenshot proof cards');
    assert(
      liveProjection.outputs.some((output) => output.ref.endsWith('/draft-artifact.html'))
        && liveProjection.outputs.some((output) => output.ref.endsWith('/final-artifact.html')),
      'Conversation projection missed generated artifact outputs',
    );

    const beforeCleanupEventCount = harness.events.length;
    await runtime.endRun(identity);
    cleanupVerified = !adapter.getBrowserService(identity).isRunning();
    assert(cleanupVerified, 'Managed browser cleanup did not release the WorkBuddy session');
    const completedSession = runtime.sessions.get(draftSession.sessionId);
    assert(completedSession?.state === 'completed', 'Surface session did not complete after cleanup');
    for (const event of harness.events.slice(beforeCleanupEventCount)) {
      projectionStore.appendSurfaceEvent('cleanup', event, completedSession);
    }
    const durableProjectionEvent = runtime.events.publish({
      sessionId: completedSession.sessionId,
      runId: completedSession.runId,
      agentId: completedSession.agentId,
    }, {
      phase: 'artifact',
      status: 'succeeded',
      userSummary: 'WorkBuddy final artifact and visual proof were projected to the conversation',
      ...(completedSession.activeTarget ? { target: completedSession.activeTarget } : {}),
      operation: {
        action: 'workbuddy_projection_checkpoint',
        risk: 'read-only evidence projection',
        expectedOutcome: 'Final artifact and fail-to-pass proof remain visible after cleanup',
      },
      observation: {
        verdict: 'pass',
        findings: ['Final artifact, screenshots, proof cards, and cleanup state were projected.'],
        confidence: 1,
      },
      evidenceRefs: [finalCard.evidenceId],
      evidence: [finalCard],
      artifactRefs: ['artifact://surface-execution-workbuddy/final-artifact.html'],
      availableControls: [],
      completedAt: Date.now(),
    });
    projectionStore.appendSurfaceEvent('projection-checkpoint', durableProjectionEvent, completedSession);
    await projectionService.flushPersistence(CONVERSATION_ID);
    const conversationSnapshot = await projectionService.getSnapshot(CONVERSATION_ID);
    const projection = projectionFor(conversationSnapshot, draftSession.sessionId);
    assert(
      projection.session.state === 'completed' && projection.writable === false,
      `Conversation projection did not preserve completed read-only state: ${projection.session.state}`,
    );
    const durableLedger = projectionStore.metadata()[SURFACE_EXECUTION_LEDGER_METADATA_KEY];
    assert(durableLedger, 'Conversation projection was not persisted to the Surface ledger');
    withoutCanary(conversationSnapshot, 'Final conversation projection');
    withoutCanary(durableLedger, 'Durable conversation projection');

    const draftEvidence: ScreenshotEvidence = {
      path: basename(draftScreenshotPath),
      sha256: sha256File(draftScreenshotPath),
      bytes: statSync(draftScreenshotPath).size,
      pixels: draftPixels,
      card: draftCard,
    };
    const finalEvidence: ScreenshotEvidence = {
      path: basename(finalScreenshotPath),
      sha256: sha256File(finalScreenshotPath),
      bytes: statSync(finalScreenshotPath).size,
      pixels: finalPixels,
      card: finalCard,
    };
    const expectedOutputFiles = [
      'SHA256SUMS',
      'after-fixed.png',
      'before-failed.png',
      'draft-artifact.html',
      'final-artifact.html',
      'proof.json',
      'run.log',
    ];
    const proof = {
      version: 1,
      status: 'passed',
      ...campaignProof,
      scenario: 'workbuddy-like-generation-browser-review-repair-reverify',
      recordedAt: new Date().toISOString(),
      runStartedAt: new Date(runStartedAt).toISOString(),
      worktree: process.cwd(),
      head: gitSha('HEAD'),
      originMain: gitSha('origin/main'),
      mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim(),
      sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
      command: acceptanceCommand(),
      browser: {
        provider: PROVIDER,
        executable,
        version,
        mode: hasFlag(args, 'visible') ? 'visible' : 'headless',
      },
      surface: {
        conversationId: CONVERSATION_ID,
        runId: RUN_ID,
        turnId: TURN_ID,
        agentId: AGENT_ID,
        surfaceSessionId: draftSession.sessionId,
        provider: draftSession.provider,
        eventCount: projection.events.length,
        evidenceCount: projection.evidence.length,
        outputCount: projection.outputs.length,
        projectionSource: projection.source,
        writable: projection.writable,
        finalSessionState: projection.session.state,
        durableLedgerPersisted: true,
        reviewEvents: projection.events
          .filter((event) => event.operation?.action.startsWith('workbuddy_business_review_'))
          .map((event) => ({
            sequence: event.sequence,
            phase: event.phase,
            status: event.status,
            userSummary: event.userSummary,
            verdict: event.observation?.verdict,
            findings: event.observation?.findings,
            evidenceRefs: event.evidenceRefs,
            artifactRefs: event.artifactRefs,
          })),
      },
      assertions: {
        generatedIntentionalFailureArtifact: true,
        managedSystemChromeOpenedDraft: true,
        draftScreenshotCapturedThisRun: true,
        draftDomBusinessReadbackFailed: true,
        draftPixelFailureBannerVerified: true,
        failureJudgmentProjected: true,
        artifactAdjustedAfterFailure: true,
        managedSystemChromeReopenedFinal: true,
        finalScreenshotCapturedThisRun: true,
        finalDomBusinessReadbackPassed: true,
        finalPixelSuccessBannerVerified: true,
        beforeAfterScreenshotsDiffer: true,
        sharedSurfaceSessionUsed: true,
        sharedSurfaceProofCardsPresent: true,
        conversationProjectionContainsFailPass: true,
        durableConversationLedgerPersisted: true,
        finalArtifactSaved: true,
        redactionCanaryAbsent: true,
        cleanupReleasedManagedBrowser: true,
      },
      stages: {
        draft: {
          artifactPath: basename(draftArtifactPath),
          artifactSha256: sha256File(draftArtifactPath),
          artifactBytes: statSync(draftArtifactPath).size,
          browserUrl: draftUrl,
          businessJudgment: draftEvaluation,
          screenshot: {
            path: draftEvidence.path,
            sha256: draftEvidence.sha256,
            bytes: draftEvidence.bytes,
            pixels: draftEvidence.pixels,
          },
          proof: proofCardSummary(draftEvidence.card),
        },
        final: {
          artifactPath: basename(finalArtifactPath),
          artifactSha256: sha256File(finalArtifactPath),
          artifactBytes: statSync(finalArtifactPath).size,
          browserUrl: finalUrl,
          businessJudgment: finalEvaluation,
          screenshot: {
            path: finalEvidence.path,
            sha256: finalEvidence.sha256,
            bytes: finalEvidence.bytes,
            pixels: finalEvidence.pixels,
          },
          proof: proofCardSummary(finalEvidence.card),
        },
      },
      canaryScan: {
        tokenSha256: sha256Buffer(CANARY),
        result: 'absent',
        inMemoryScopes: [
          'tool results',
          'Surface event stream',
          'live conversation projection',
          'durable conversation projection',
        ],
        scannedFiles: expectedOutputFiles,
      },
    };
    withoutCanary(proof, 'WorkBuddy acceptance proof');
    const proofPath = join(outputDir, 'proof.json');
    writeFileSync(proofPath, `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
    const runLogPath = join(outputDir, 'run.log');
    writeFileSync(runLogPath, [
      'Surface Execution WorkBuddy Managed Acceptance',
      `recordedAt=${proof.recordedAt}`,
      `command=${proof.command}`,
      `worktree=${proof.worktree}`,
      `head=${proof.head}`,
      `originMain=${proof.originMain}`,
      `mergeBase=${proof.mergeBase}`,
      `browserVersion=${version}`,
      `surfaceSessionId=${draftSession.sessionId}`,
      `draftJudgment=${draftEvaluation.verdict}`,
      `draftScreenshotSha256=${draftEvidence.sha256}`,
      `finalJudgment=${finalEvaluation.verdict}`,
      `finalScreenshotSha256=${finalEvidence.sha256}`,
      'canaryScan=absent',
      'cleanupReleasedManagedBrowser=true',
      '',
    ].join('\n'), 'utf8');
    const checksumPaths = [
      draftArtifactPath,
      finalArtifactPath,
      draftScreenshotPath,
      finalScreenshotPath,
      proofPath,
      runLogPath,
    ];
    writeFileSync(join(outputDir, 'SHA256SUMS'), `${checksumPaths
      .map((path) => `${sha256File(path)}  ${basename(path)}`)
      .join('\n')}\n`, 'utf8');
    const scannedFiles = scanFilesForCanary(outputDir);
    assert(
      expectedOutputFiles.every((filename) => scannedFiles.includes(filename)),
      `Canary scan missed expected output files: ${scannedFiles.join(', ')}`,
    );

    if (hasFlag(args, 'json')) {
      printJson({
        ok: true,
        outputDir,
        proofPath,
        surfaceSessionId: draftSession.sessionId,
        draftVerdict: draftEvaluation.verdict,
        finalVerdict: finalEvaluation.verdict,
        draftScreenshotSha256: draftEvidence.sha256,
        finalScreenshotSha256: finalEvidence.sha256,
        canaryScan: 'absent',
      });
    } else {
      printKeyValue('Surface Execution WorkBuddy Managed Acceptance', [
        ['ok', true],
        ['browserVersion', version],
        ['surfaceSessionId', draftSession.sessionId],
        ['draftVerdict', draftEvaluation.verdict],
        ['finalVerdict', finalEvaluation.verdict],
        ['eventCount', projection.events.length],
        ['evidenceCount', projection.evidence.length],
        ['canaryScan', 'absent'],
        ['outputDir', outputDir],
        ['proofPath', proofPath],
      ]);
    }
  } finally {
    if (!cleanupVerified && identity) {
      await runtime.endRun(identity).catch(() => undefined);
    }
    projectionService.dispose();
    await closeServer(fixture.server);
    registry.clear();
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
  }
}

main().catch(finishWithError);
