import { createHash } from 'node:crypto';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  getApplicationRunRegistry,
  resetApplicationRunRegistryForTests,
} from '../../src/host/app/applicationRunRegistry.ts';
import { CuaMcpDriverPort } from '../../src/host/mcp/cuaMcpDriverPort.ts';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../src/host/mcp/cuaStateAdapter.ts';
import { getDefaultMCPServers } from '../../src/host/mcp/mcpDefaultServers.ts';
import { getMCPClient } from '../../src/host/mcp/mcpClient.ts';
import { CUA_DRIVER_SERVER_NAME } from '../../src/host/mcp/types.ts';
import { CuaStatefulComputerUseHandler } from '../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.ts';
import type {
  CanUseToolFn,
  ToolContext as ComputerToolContext,
  ToolResult as ComputerToolResult,
} from '../../src/host/protocol/tools.ts';
import { SurfaceConversationProjectionService } from '../../src/host/services/surfaceExecution/SurfaceConversationProjectionService.ts';
import type { BrowserDomSnapshot } from '../../src/host/services/infra/browserService.ts';
import type { SessionWithMessages } from '../../src/host/services/infra/sessionManager.ts';
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
import type { ToolContext, ToolExecutionResult } from '../../src/host/tools/types.ts';
import type { Message } from '../../src/shared/contract/index.ts';
import type {
  ComputerUseRootRefV1,
  ComputerUseStateViewV1,
} from '../../src/shared/contract/desktop.ts';
import {
  isSurfaceExecutionEventV1,
  type SurfaceExecutionEventV1,
} from '../../src/shared/contract/surfaceExecution.ts';
import { attachSurfaceExecutionResultProjection } from '../../src/host/services/surfaceExecution/surfaceExecutionResultProjection.ts';
import {
  assertCrossSurfaceAcceptanceInvariants,
  crossSurfaceExternalPermissionBlock,
  evaluateCrossSurfaceComputerPermissions,
} from './fixtures/surface-execution-cross-surface.ts';
import {
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

const CONVERSATION_ID = 'surface-cross-acceptance';
const RUN_ID = 'surface-cross-run';
const OWNER_AGENT_ID = 'surface-cross-owner';
const FOREIGN_AGENT_ID = 'surface-cross-foreign';
const CANARY = 'surface-secret-canary-cross-surface';
const COMPUTER_BUSINESS_VALUE = 'cross-surface-computer-business-verified';
const COMPUTER_TARGET_APP = 'NeoCrossSurfaceComputerFixture';
const COMPUTER_TARGET_WINDOW_TITLE = 'Neo Cross Surface Computer Acceptance';
const COMPUTER_TARGET_FIELD_LABEL = 'Neo Cross Surface Business Input';
const TO_COMPUTER_REASON = 'Native Computer observation and verified input are required for this task.';
const TO_BROWSER_REASON = 'Computer business verification completed; returning to Browser business verification.';
const MUTATING_CUA_TOOLS = new Set([
  'click', 'double_click', 'right_click', 'set_value', 'type_text',
  'press_key', 'hotkey', 'scroll', 'drag',
]);

type AcceptanceStatus = 'passed' | 'blocked' | 'failed';
type TargetProcess = ChildProcessByStdio<null, Readable, Readable>;

class AcceptanceExternalBlockedError extends Error {
  constructor(
    message: string,
    readonly missing: string[],
  ) {
    super(message);
    this.name = 'AcceptanceExternalBlockedError';
  }
}

interface Harness {
  agentId: string;
  events: SurfaceExecutionEventV1[];
  sequence: number;
}

interface CommandEvidence {
  command: string;
  args: string[];
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

interface DriverCallEvidence {
  toolName: string;
  at: string;
  surfaceSessionId?: string;
  mutating: boolean;
  forwarded: boolean;
}

interface TargetFixture {
  process: TargetProcess;
  binaryPath: string;
  statePath: string;
  stderr: () => string;
}

interface StatefulResponse {
  version: 1;
  operation: 'list_roots' | 'observe' | 'act';
  roots?: ComputerUseRootRefV1[];
  state?: ComputerUseStateViewV1;
  result?: {
    delivery?: string;
    verification?: string;
    overall?: string;
    successorState?: ComputerUseStateViewV1;
  };
}

class RecordingCuaDriverPort implements CuaDriverPort {
  readonly calls: DriverCallEvidence[] = [];

  constructor(private readonly delegate: CuaDriverPort) {}

  async call(
    toolName: string,
    args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    const evidence: DriverCallEvidence = {
      toolName,
      at: new Date().toISOString(),
      ...(context.surfaceSessionId ? { surfaceSessionId: context.surfaceSessionId } : {}),
      mutating: MUTATING_CUA_TOOLS.has(toolName),
      forwarded: false,
    };
    this.calls.push(evidence);
    const result = await this.delegate.call(toolName, args, context);
    evidence.forwarded = true;
    return result;
  }

  getGeneration(): string | undefined {
    return this.delegate.getGeneration();
  }
}

function usage(): void {
  console.log(`Surface Execution cross-Surface acceptance

Usage:
  npm run acceptance:surface-execution-cross-surface -- [options]

Options:
  --visible         Launch the isolated Managed Browser visibly.
  --out <directory> Persist proof, screenshots, helper logs, and permission evidence.
  --helper <binary> Override the signed Agent Neo Computer Use helper binary.
  --json            Print JSON only.
  --help            Show this help.

Runs one owner through a real Managed Browser, signed Computer observe/input/
business verification through the stateful production provider and lock, then a
continuation in the original Browser session. Missing helper or permissions are
recorded as blocked_external evidence with zero Computer mutation.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function gitSha(ref: string): string {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function runEvidence(command: string, args: string[]): CommandEvidence {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  });
  return {
    command,
    args,
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function parseCodesign(details: string): {
  identifier: string | null;
  teamIdentifier: string | null;
  authority: string | null;
  cdHash: string | null;
} {
  const value = (key: string) => details.match(new RegExp(`^${key}=(.+)$`, 'm'))?.[1]?.trim() || null;
  return {
    identifier: value('Identifier'),
    teamIdentifier: value('TeamIdentifier'),
    authority: value('Authority'),
    cdHash: value('CDHash'),
  };
}

function parseStructured(output: string | undefined, structured: unknown): Record<string, unknown> {
  if (structured && typeof structured === 'object' && !Array.isArray(structured)) {
    return structured as Record<string, unknown>;
  }
  if (!output) return {};
  try {
    const parsed: unknown = JSON.parse(output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function computerLogger(): ComputerToolContext['logger'] {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function computerContext(harness: Harness, label: string): ComputerToolContext {
  harness.sequence += 1;
  return {
    runId: RUN_ID,
    turnId: 'turn-cross-surface',
    sessionId: CONVERSATION_ID,
    workspace: process.cwd(),
    workingDir: process.cwd(),
    abortSignal: new AbortController().signal,
    agentId: harness.agentId,
    currentToolCallId: `${harness.agentId}:${label}:${harness.sequence}`,
    logger: computerLogger(),
    emit(event) {
      const candidate = event as { type?: string; data?: unknown };
      if (candidate.type === 'surface_execution' && candidate.data) {
        harness.events.push(candidate.data as SurfaceExecutionEventV1);
      }
    },
  };
}

async function executeComputer(
  handler: CuaStatefulComputerUseHandler,
  harness: Harness,
  label: string,
  request: Record<string, unknown>,
  canUseTool: CanUseToolFn,
): Promise<ComputerToolResult<string>> {
  return handler.execute(request, computerContext(harness, label), canUseTool);
}

function parseComputerResponse(
  result: ComputerToolResult<string>,
  label: string,
): StatefulResponse {
  assert(result.ok, `${label} failed: ${result.code || 'unknown'} ${result.error || ''}`.trim());
  try {
    return JSON.parse(result.output) as StatefulResponse;
  } catch {
    throw new Error(`${label} returned non-JSON output`);
  }
}

function computerState(result: ComputerToolResult<string>, label: string): ComputerUseStateViewV1 {
  const response = parseComputerResponse(result, label);
  assert(response.operation === 'observe' && response.state, `${label} did not return an observation`);
  return response.state;
}

function computerSurfaceSessionId(result: ComputerToolResult<string>, label: string): string {
  const session = result.meta?.surfaceExecutionSessionV1 as { sessionId?: unknown } | undefined;
  assert(typeof session?.sessionId === 'string', `${label} did not return a Surface Session id`);
  return session.sessionId;
}

function findComputerInput(state: ComputerUseStateViewV1) {
  const exact = state.elements.find((element) => element.label === COMPUTER_TARGET_FIELD_LABEL);
  const field = exact || state.elements.find((element) => /textfield|text field/i.test(element.role));
  assert(field, `Computer observation did not expose the fixture text field: ${state.elements
    .map((element) => `${element.role}:${element.label || ''}`)
    .join(',')}`);
  return field;
}

function dataUrlFromComputerResult(result: ComputerToolResult<string>): string | null {
  const value = result.meta?.imageBase64;
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

function saveDataUrl(dataUrl: string, target: string): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const comma = dataUrl.indexOf(',');
  assert(comma > 0 && dataUrl.slice(0, comma).includes(';base64'), 'Computer screenshot data URL is invalid');
  const data = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  assert(data.length > 0, 'Computer screenshot decoded to zero bytes');
  writeFileSync(target, data);
  return { path: target, sha256: sha256(data), bytes: data.length };
}

function makeTargetSource(): string {
  return `#import <Cocoa/Cocoa.h>

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *statePath;
@property(nonatomic, retain) NSTextField *inputField;
@property(nonatomic, retain) NSWindow *window;
@end

@implementation AppDelegate
- (instancetype)initWithStatePath:(NSString *)statePath {
  self = [super init];
  if (self) self.statePath = statePath;
  return self;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(0, 0, 460, 190);
  self.window = [[NSWindow alloc]
    initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
    backing:NSBackingStoreBuffered
    defer:NO];
  [self.window setTitle:@"${COMPUTER_TARGET_WINDOW_TITLE}"];
  [self.window center];
  NSView *content = [[NSView alloc] initWithFrame:frame];
  [self.window setContentView:content];
  NSTextField *title = [NSTextField labelWithString:@"Neo Cross Surface Computer Fixture"];
  [title setFrame:NSMakeRect(24, 132, 400, 24)];
  [content addSubview:title];
  self.inputField = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 82, 380, 30)];
  [self.inputField setPlaceholderString:@"Cross Surface business readback"];
  [self.inputField setAccessibilityLabel:@"${COMPUTER_TARGET_FIELD_LABEL}"];
  [self.inputField setAccessibilityIdentifier:@"neo-cross-surface-business-input"];
  [content addSubview:self.inputField];
  NSTextField *status = [NSTextField labelWithString:@"Controlled Browser to Computer continuation fixture"];
  [status setFrame:NSMakeRect(24, 46, 400, 22)];
  [content addSubview:status];
  [NSTimer scheduledTimerWithTimeInterval:0.05
    target:self selector:@selector(writeCurrentState:) userInfo:nil repeats:YES];
  [self.window setInitialFirstResponder:self.inputField];
  [self.window makeKeyAndOrderFront:nil];
  [self.window makeFirstResponder:self.inputField];
  [NSApp activateIgnoringOtherApps:YES];
  [self writeCurrentState:nil];
}
- (void)writeCurrentState:(NSTimer *)timer {
  NSString *state = [NSString stringWithFormat:@"value=%@", [self.inputField stringValue]];
  [state writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender { return YES; }
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSString *statePath = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"/tmp/neo-cross-surface-fixture-state.txt";
    AppDelegate *delegate = [[AppDelegate alloc] initWithStatePath:statePath];
    [app setDelegate:delegate];
    [app run];
  }
  return 0;
}
`;
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, intervalMs));
  }
  return predicate();
}

function readFixtureState(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function computerLockOwner(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  } catch {
    return null;
  }
}

async function startTargetFixture(tempRoot: string): Promise<TargetFixture> {
  const sourcePath = join(tempRoot, `${COMPUTER_TARGET_APP}.m`);
  const appPath = join(tempRoot, `${COMPUTER_TARGET_APP}.app`);
  const contentsPath = join(appPath, 'Contents');
  const executableDir = join(contentsPath, 'MacOS');
  const binaryPath = join(executableDir, COMPUTER_TARGET_APP);
  const statePath = join(tempRoot, 'computer-fixture-state.txt');
  mkdirSync(executableDir, { recursive: true });
  writeFileSync(join(contentsPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${COMPUTER_TARGET_APP}</string>
  <key>CFBundleIdentifier</key><string>com.agentneo.surface-cross-computer-fixture</string>
  <key>CFBundleName</key><string>${COMPUTER_TARGET_APP}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`, 'utf8');
  writeFileSync(sourcePath, makeTargetSource(), 'utf8');
  execFileSync('clang', [sourcePath, '-o', binaryPath, '-framework', 'Cocoa'], {
    cwd: tempRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const child = spawn(binaryPath, [statePath], {
    cwd: tempRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const ready = await waitFor(() => readFixtureState(statePath) === 'value=', 10_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Computer fixture did not become ready: ${readFixtureState(statePath) || 'missing'} ${stderr}`);
  }
  return { process: child, binaryPath, statePath, stderr: () => stderr };
}

async function stopTargetFixture(fixture: TargetFixture | null): Promise<void> {
  if (!fixture || fixture.process.exitCode !== null) return;
  fixture.process.kill('SIGTERM');
  const exited = await Promise.race([
    new Promise<boolean>((resolveExit) => fixture.process.once('exit', () => resolveExit(true))),
    new Promise<boolean>((resolveTimeout) => setTimeout(() => resolveTimeout(false), 1_000)),
  ]);
  if (!exited && fixture.process.exitCode === null) fixture.process.kill('SIGKILL');
}

async function waitForComputerRoot(
  handler: CuaStatefulComputerUseHandler,
  harness: Harness,
  processId: number,
  canUseTool: CanUseToolFn,
): Promise<ComputerUseRootRefV1> {
  let sequence = 0;
  let roots: ComputerUseRootRefV1[] = [];
  let matched: ComputerUseRootRefV1 | undefined;
  const found = await waitFor(async () => {
    sequence += 1;
    const listed = await executeComputer(handler, harness, `list-roots-${sequence}`, {
      operation: 'list_roots',
      onScreenOnly: false,
    }, canUseTool);
    const response = parseComputerResponse(listed, `list_roots ${sequence}`);
    roots = response.roots || [];
    matched = roots.find((root) => (
      root.pid === processId && root.title === COMPUTER_TARGET_WINDOW_TITLE
    ));
    return Boolean(matched);
  }, 10_000, 250);
  assert(found && matched, `Computer provider did not list the fixture business window for pid ${processId}: ${roots
    .map((root) => `${root.pid}:${root.appName || ''}:${root.title || ''}`)
    .join(',')}`);
  return matched;
}

async function startFixtureServer(): Promise<{ server: Server; baseUrl: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(`<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Cross Surface Acceptance</title></head>
  <body data-continuation="pending">
    <main>
      <h1>Cross Surface Browser Fixture</h1>
      <label>Secret <input id="secret" type="password" autocomplete="off"></label>
      <button id="continue" onclick="document.body.dataset.continuation='verified'; document.querySelector('#status').textContent='Browser continuation verified'">Continue after Computer probe</button>
      <p id="status">Browser ready before Computer probe</p>
    </main>
  </body>
</html>`);
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  assert(address && typeof address !== 'string', 'Cross-Surface fixture did not bind a port');
  return { server, baseUrl: `http://127.0.0.1:${address.port}` };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => server.close(() => resolveClose()));
}

function contextFor(harness: Harness, label: string): ToolContext {
  harness.sequence += 1;
  return {
    workingDirectory: process.cwd(),
    workspace: process.cwd(),
    sessionId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: 'turn-cross-surface',
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

async function executeBrowser(
  harness: Harness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  return browserActionTool.execute(params, contextFor(harness, label));
}

async function requireBrowserSuccess(
  harness: Harness,
  label: string,
  params: Record<string, unknown>,
): Promise<ToolExecutionResult> {
  const result = await executeBrowser(harness, label, params);
  assert(result.success, `${label} failed: ${result.error || 'unknown Browser error'}`);
  return result;
}

function domSnapshot(result: ToolExecutionResult): BrowserDomSnapshot {
  const snapshot = result.metadata?.domSnapshot as BrowserDomSnapshot | undefined;
  assert(snapshot, 'Managed Browser result did not include a DOM snapshot');
  return snapshot;
}

function targetRef(snapshot: BrowserDomSnapshot, selectorHint: string) {
  const element = snapshot.interactiveElements.find((candidate) => (
    candidate.selectorHint === selectorHint
  ));
  assert(element, `DOM snapshot did not include ${selectorHint}`);
  assert(element.targetRef.refId, `DOM snapshot targetRef for ${selectorHint} is missing refId`);
  return element.targetRef.refId;
}

function saveScreenshot(result: ToolExecutionResult, path: string): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const source = String(result.metadata?.path || '');
  assert(source && statSync(source).isFile(), `Managed screenshot is missing: ${source}`);
  copyFileSync(source, path);
  const data = readFileSync(path);
  return { path, sha256: sha256(data), bytes: data.length };
}

function switchEvent(
  events: SurfaceExecutionEventV1[],
  fromSessionId: string,
  reason: string,
): SurfaceExecutionEventV1 {
  const event = events.find((candidate) => (
    candidate.operation?.action === 'surface_switch'
    && candidate.operation.approvalScope === `from:${fromSessionId}`
    && candidate.operation.expectedOutcome === reason
  ));
  assert(event, `Missing surface_switch from ${fromSessionId}: ${reason}`);
  return event;
}

function resultCode(result: ToolExecutionResult): string | null {
  const surfaceError = result.metadata?.surfaceExecutionErrorV1 as { code?: unknown } | undefined;
  return typeof surfaceError?.code === 'string'
    ? surfaceError.code
    : typeof result.metadata?.code === 'string' ? result.metadata.code : null;
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
  if (process.platform !== 'darwin') throw new Error('Cross-Surface acceptance requires macOS.');

  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-cross-proof-')));
  mkdirSync(outputDir, { recursive: true });
  const helperPath = resolve(getStringOption(args, 'helper') || join(
    '.tauri-resources.noindex',
    'scripts',
    'Agent Neo Computer Use.app',
    'Contents',
    'MacOS',
    'cua-driver',
  ));
  const helperApp = resolve(dirname(helperPath), '..', '..');
  const tempRoot = mkdtempSync(join(tmpdir(), 'surface-execution-cross-runtime-'));
  process.env.CODE_AGENT_BROWSER_PROVIDER = 'system-chrome-cdp';
  process.env.CODE_AGENT_BROWSER_VISIBLE = hasFlag(args, 'visible') ? '1' : '0';
  process.env.CODE_AGENT_ENABLE_CUA = '1';
  process.env.CODE_AGENT_CUA_STATE_V2 = '1';
  process.env.CODE_AGENT_CUA_DRIVER_PATH = helperPath;
  process.env.CODE_AGENT_CU_LOCK_PATH = join(tempRoot, 'computer-use.lock');

  resetManagedBrowserProviderAdapterForTests();
  resetSurfaceExecutionRuntimeForTests();
  resetApplicationRunRegistryForTests();
  const registry = getApplicationRunRegistry();
  registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
  const runtime = getSurfaceExecutionRuntime();
  const adapter = getManagedBrowserProviderAdapter();
  const client = getMCPClient();
  const directPort = new CuaMcpDriverPort();
  const recordingPort = new RecordingCuaDriverPort(directPort);
  const computerHandler = new CuaStatefulComputerUseHandler(
    new CuaStateAdapter(recordingPort),
    runtime,
  );
  const owner: Harness = { agentId: OWNER_AGENT_ID, events: [], sequence: 0 };
  const foreign: Harness = { agentId: FOREIGN_AGENT_ID, events: [], sequence: 0 };
  const computerPermissionRequests: Array<Record<string, unknown>> = [];
  const canUseComputer: CanUseToolFn = async (_toolName, input) => {
    const surfaceTarget = input.surfaceTarget as Record<string, unknown> | undefined;
    computerPermissionRequests.push({
      ...(surfaceTarget
        ? {
            surface: surfaceTarget.kind,
            appName: surfaceTarget.appName,
            windowRef: surfaceTarget.windowRef,
          }
        : {}),
    });
    return { allow: true };
  };
  const identity = surfaceIdentityFromToolContext(contextFor(owner, 'identity'));
  assert(identity, 'Cross-Surface owner identity is unavailable');

  let fixture: { server: Server; baseUrl: string } | null = null;
  let computerFixture: TargetFixture | null = null;
  let status: AcceptanceStatus = 'failed';
  let failure: string | null = null;
  let serverAdded = false;
  let runEnded = false;
  let mcpDisconnected = true;
  const proof: Record<string, unknown> = {
    version: 1,
    status,
    ...campaignProof,
    stage: 'setup',
    recordedAt: new Date().toISOString(),
    worktree: process.cwd(),
    head: gitSha('HEAD'),
    originMain: gitSha('origin/main'),
    mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim(),
    sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
    invocation: ['npm', 'run', 'acceptance:surface-execution-cross-surface', '--', ...process.argv.slice(2)],
    assertions: {},
    evidence: {},
  };
  const assertions = proof.assertions as Record<string, unknown>;
  const evidence = proof.evidence as Record<string, unknown>;

  try {
    proof.stage = 'managed-before';
    fixture = await startFixtureServer();
    const navigation = await requireBrowserSuccess(owner, 'navigate-before', {
      action: 'navigate',
      url: fixture.baseUrl,
      engine: 'managed',
    });
    const initial = domSnapshot(await requireBrowserSuccess(owner, 'dom-before', {
      action: 'get_dom_snapshot',
    }));
    const secretRef = targetRef(initial, '#secret');
    const typed = await requireBrowserSuccess(owner, 'type-canary', {
      action: 'type',
      targetRef: secretRef,
      text: CANARY,
    });
    withoutCanary(typed, 'Managed Browser type result');
    const postType = domSnapshot(await requireBrowserSuccess(owner, 'dom-post-type', {
      action: 'get_dom_snapshot',
    }));
    const isolationRef = targetRef(postType, '#continue');
    const beforeContent = await requireBrowserSuccess(owner, 'content-before', {
      action: 'get_content',
    });
    assert(beforeContent.output?.includes('Browser ready before Computer probe'), 'Before readback failed');
    const beforeScreenshot = saveScreenshot(
      await requireBrowserSuccess(owner, 'screenshot-before', {
        action: 'screenshot',
        fullPage: true,
        analyze: false,
      }),
      join(outputDir, 'browser-before.png'),
    );
    const browserBinding = adapter.getBinding(identity);
    assert(browserBinding, 'Managed Browser binding is unavailable');
    const browserSessionId = browserBinding.surfaceSessionId;
    assertions.realManagedBrowserBefore = navigation.success && beforeScreenshot.bytes > 0;

    proof.stage = 'owner-isolation';
    const foreignAttempt = await executeBrowser(foreign, 'foreign-target', {
      action: 'click',
      targetRef: isolationRef,
      engine: 'managed',
    });
    const ownerAfterForeign = await requireBrowserSuccess(owner, 'content-after-foreign', {
      action: 'get_content',
    });
    const ownerIsolationBlocked = !foreignAttempt.success
      && ownerAfterForeign.output?.includes('Browser ready before Computer probe') === true;
    assert(ownerIsolationBlocked, 'Cross-agent target attempt changed the owner Browser page');
    assertions.crossAgentTargetBlocked = true;
    evidence.crossAgentResultCode = resultCode(foreignAttempt);
    const continuationSnapshot = domSnapshot(await requireBrowserSuccess(
      owner,
      'dom-before-computer',
      { action: 'get_dom_snapshot' },
    ));
    const continueRef = targetRef(continuationSnapshot, '#continue');

    proof.stage = 'computer-permission';
    const computerPrepared = runtime.prepareComputerSession({
      identity,
      switchReason: TO_COMPUTER_REASON,
    });
    const computerSessionId = computerPrepared.session.sessionId;
    assert(
      computerPrepared.session.parentSessionId === browserSessionId,
      'Computer Surface did not link to the originating Browser session',
    );
    const toComputerEvent = switchEvent(
      runtime.events.listOwned(computerPrepared.subject),
      browserSessionId,
      TO_COMPUTER_REASON,
    );
    if (!existsSync(helperPath) || !statSync(helperPath).isFile()) {
      throw new AcceptanceExternalBlockedError(
        `Signed Computer helper is missing: ${helperPath}`,
        ['signed_helper'],
      );
    }
    const version = runEvidence(helperPath, ['--version']);
    const signatureVerify = runEvidence('codesign', ['--verify', '--strict', '--verbose=2', helperApp]);
    const signatureDetails = runEvidence('codesign', ['-d', '--verbose=4', helperApp]);
    writeFileSync(join(outputDir, 'helper-version.txt'), `${version.stdout}${version.stderr}`, 'utf8');
    writeFileSync(
      join(outputDir, 'codesign.txt'),
      `${signatureVerify.stdout}${signatureVerify.stderr}${signatureDetails.stdout}${signatureDetails.stderr}`,
      'utf8',
    );
    assert(version.exitCode === 0 && version.stdout.trim() === 'cua-driver 0.8.1', 'Unexpected helper version');
    assert(signatureVerify.exitCode === 0, `codesign verification failed: ${signatureVerify.stderr}`);
    const signature = parseCodesign(`${signatureDetails.stdout}\n${signatureDetails.stderr}`);
    assert(signature.identifier === 'com.agentneo.computeruse', `Unexpected helper id: ${signature.identifier}`);
    assert(signature.teamIdentifier === 'D7CVTJ72NV', `Unexpected helper team: ${signature.teamIdentifier}`);
    const server = getDefaultMCPServers().find((candidate) => candidate.name === CUA_DRIVER_SERVER_NAME);
    if (!server?.enabled) {
      throw new AcceptanceExternalBlockedError(
        'Signed Computer helper MCP server is unavailable',
        ['helper_mcp_server'],
      );
    }
    client.addServer(server);
    serverAdded = true;
    mcpDisconnected = false;
    if (!await client.ensureConnected(CUA_DRIVER_SERVER_NAME)) {
      throw new AcceptanceExternalBlockedError(
        'Signed Computer helper MCP connection failed',
        ['helper_mcp_connection'],
      );
    }
    const permissionResult = await recordingPort.call('check_permissions', { prompt: false }, {
      sessionId: CONVERSATION_ID,
      surfaceSessionId: computerSessionId,
      runId: RUN_ID,
      agentId: OWNER_AGENT_ID,
      toolCallId: 'cross-surface-permission-probe',
      abortSignal: new AbortController().signal,
    });
    const permissionStructured = parseStructured(permissionResult.output, permissionResult.structured);
    const permission = evaluateCrossSurfaceComputerPermissions(permissionStructured, helperPath);
    const externalBlock = crossSurfaceExternalPermissionBlock(permission);
    let computerMutationAttempted = recordingPort.calls.filter((call) => (
      MUTATING_CUA_TOOLS.has(call.toolName)
    )).length;
    let computerMutationForwarded = recordingPort.calls.filter((call) => (
      call.mutating && call.forwarded
    )).length;
    writeFileSync(join(outputDir, 'permissions.json'), `${JSON.stringify({
      prompt: false,
      callSucceeded: permissionResult.success,
      structured: permissionStructured,
      decision: permission,
    }, null, 2)}\n`, 'utf8');
    assertions.signedHelperVersion081 = true;
    assertions.signedHelperCodesignValid = true;
    assertions.realComputerPermissionProbe = permissionResult.success;
    assertions.permissionProbePromptFalse = true;
    evidence.helper = {
      path: helperPath,
      app: helperApp,
      signature,
      providerGeneration: directPort.getGeneration() || null,
    };
    evidence.permission = permission;
    if (!permissionResult.success || externalBlock) {
      assert(computerMutationAttempted === 0, 'Computer mutation was attempted before permissions were ready');
      assert(computerMutationForwarded === 0, 'Computer mutation reached the provider before permissions were ready');
      assertions.computerMutationAttemptedZero = true;
      assertions.computerMutationForwardedZero = true;
      const missing = Array.from(new Set([
        ...permission.missing,
        ...(!permissionResult.success ? ['helper_permission_probe'] : []),
      ]));
      throw new AcceptanceExternalBlockedError(
        permissionResult.error
          || permissionResult.output
          || `Computer permissions are not ready: ${missing.join(', ')}`,
        missing,
      );
    }

    proof.stage = 'computer-observe';
    computerFixture = await startTargetFixture(tempRoot);
    assert(typeof computerFixture.process.pid === 'number', 'Computer fixture has no process id');
    const computerRoot = await waitForComputerRoot(
      computerHandler,
      owner,
      computerFixture.process.pid,
      canUseComputer,
    );
    assert(
      computerRoot.pid === computerFixture.process.pid
        && Number.isInteger(computerRoot.windowId)
        && computerRoot.windowId > 0,
      `Computer fixture root identity mismatch: ${computerRoot.pid}:${computerRoot.windowId}`,
    );
    if (computerRoot.title?.trim()) {
      assert(
        computerRoot.title === COMPUTER_TARGET_WINDOW_TITLE,
        `Computer fixture root title mismatch: ${computerRoot.title}`,
      );
    }
    const initialComputerObservation = await executeComputer(
      computerHandler,
      owner,
      'computer-observe-before',
      {
        operation: 'observe',
        target: { pid: computerRoot.pid, windowId: computerRoot.windowId },
        query: COMPUTER_TARGET_FIELD_LABEL,
        includeScreenshot: true,
      },
      canUseComputer,
    );
    const initialComputerState = computerState(initialComputerObservation, 'Computer observe before');
    const observedComputerSessionId = computerSurfaceSessionId(
      initialComputerObservation,
      'Computer observe before',
    );
    assert(
      observedComputerSessionId === computerSessionId,
      'Stateful Computer provider did not use the prepared shared-control-plane session',
    );
    const initialComputerInput = findComputerInput(initialComputerState);
    const initialComputerImage = dataUrlFromComputerResult(initialComputerObservation);
    assert(initialComputerImage, 'Computer observe did not return a real screenshot');
    const computerBeforeScreenshot = saveDataUrl(
      initialComputerImage,
      join(outputDir, 'computer-before.png'),
    );

    proof.stage = 'computer-input';
    const foreignComputerAttempt = await executeComputer(
      computerHandler,
      foreign,
      'foreign-computer-input',
      {
        operation: 'act',
        stateId: initialComputerState.stateId,
        mutation: {
          kind: 'set_value',
          elementRef: initialComputerInput.ref,
          value: 'foreign-computer-input-must-not-run',
        },
      },
      canUseComputer,
    );
    assert(
      !foreignComputerAttempt.ok && foreignComputerAttempt.code === 'SURFACE_STATE_STALE',
      `Cross-agent Computer state was not blocked: ${JSON.stringify(foreignComputerAttempt)}`,
    );
    assert(
      readFixtureState(computerFixture.statePath) === 'value=',
      'Cross-agent Computer attempt changed the fixture',
    );
    const computerBusinessAction = await executeComputer(
      computerHandler,
      owner,
      'computer-business-input',
      {
        operation: 'act',
        stateId: initialComputerState.stateId,
        mutation: {
          kind: 'set_value',
          elementRef: initialComputerInput.ref,
          value: COMPUTER_BUSINESS_VALUE,
        },
        expect: {
          kind: 'text_present',
          text: COMPUTER_BUSINESS_VALUE,
        },
      },
      canUseComputer,
    );
    const computerBusinessResponse = parseComputerResponse(
      computerBusinessAction,
      'Computer business input',
    );
    assert(computerBusinessResponse.operation === 'act' && computerBusinessResponse.result, 'Computer action returned no result');
    assert(computerBusinessResponse.result.delivery === 'confirmed', `Computer delivery was ${computerBusinessResponse.result.delivery}`);
    assert(computerBusinessResponse.result.verification === 'satisfied', `Computer verification was ${computerBusinessResponse.result.verification}`);
    assert(computerBusinessResponse.result.overall === 'succeeded', `Computer result was ${computerBusinessResponse.result.overall}`);
    assert(
      await waitFor(
        () => readFixtureState(computerFixture?.statePath || '') === `value=${COMPUTER_BUSINESS_VALUE}`,
        5_000,
      ),
      `Computer fixture business readback failed: ${readFixtureState(computerFixture.statePath)}`,
    );
    const computerLockPath = process.env.CODE_AGENT_CU_LOCK_PATH || '';
    const lockOwnerAfterMutation = computerLockOwner(computerLockPath);
    assert(
      lockOwnerAfterMutation === null || lockOwnerAfterMutation === computerSessionId,
      `Production Computer input lock was displaced by ${lockOwnerAfterMutation}`,
    );
    const computerAcquireEvents = runtime.events.listOwned(computerPrepared.subject).filter((event) => (
      event.operation?.action === 'computer_input_lock_acquire'
    ));
    assert(
      computerAcquireEvents.some((event) => event.status === 'succeeded'),
      'Computer mutation did not expose a successful production lock acquire event',
    );

    proof.stage = 'computer-verify';
    const verifiedComputerObservation = await executeComputer(
      computerHandler,
      owner,
      'computer-observe-after',
      {
        operation: 'observe',
        target: { pid: computerRoot.pid, windowId: computerRoot.windowId },
        query: COMPUTER_TARGET_FIELD_LABEL,
        includeScreenshot: true,
      },
      canUseComputer,
    );
    const verifiedComputerState = computerState(verifiedComputerObservation, 'Computer observe after');
    const verifiedComputerInput = findComputerInput(verifiedComputerState);
    assert(
      verifiedComputerInput.value === COMPUTER_BUSINESS_VALUE,
      `Computer successor observe read ${String(verifiedComputerInput.value)}`,
    );
    const verifiedComputerImage = dataUrlFromComputerResult(verifiedComputerObservation);
    assert(verifiedComputerImage, 'Computer verify did not return a real screenshot');
    const computerAfterScreenshot = saveDataUrl(
      verifiedComputerImage,
      join(outputDir, 'computer-after.png'),
    );
    computerMutationAttempted = recordingPort.calls.filter((call) => call.mutating).length;
    computerMutationForwarded = recordingPort.calls.filter((call) => call.mutating && call.forwarded).length;
    assert(computerMutationAttempted === 1, `Expected one Computer mutation attempt, observed ${computerMutationAttempted}`);
    assert(computerMutationForwarded === 1, `Expected one forwarded Computer mutation, observed ${computerMutationForwarded}`);
    assertions.realComputerObserved = true;
    assertions.realComputerMutationDelivered = true;
    assertions.realComputerBusinessVerified = true;
    assertions.computerCrossAgentInputBlocked = true;
    assertions.computerInputLockAcquired = true;
    evidence.computer = {
      sessionId: computerSessionId,
      target: computerRoot,
      stateBefore: initialComputerState.stateId,
      stateAfter: verifiedComputerState.stateId,
      fixtureReadback: readFixtureState(computerFixture.statePath),
      beforeScreenshot: computerBeforeScreenshot,
      afterScreenshot: computerAfterScreenshot,
      lockOwnerAfterMutation,
      lockEventsBeforeCleanup: computerAcquireEvents,
    };
    evidence.providerCalls = recordingPort.calls;

    proof.stage = 'browser-continuation';
    const browserReactivated = runtime.prepareBrowserSession({
      identity,
      provider: browserBinding.provider,
      switchReason: TO_BROWSER_REASON,
    });
    assert(
      browserReactivated.session.sessionId === browserSessionId,
      'Browser continuation did not reuse the original Managed Surface session',
    );
    const toBrowserEvent = switchEvent(
      runtime.events.listOwned(browserReactivated.subject),
      computerSessionId,
      TO_BROWSER_REASON,
    );
    await requireBrowserSuccess(owner, 'continue-after-computer', {
      action: 'click',
      targetRef: continueRef,
    });
    const continuedContent = await requireBrowserSuccess(owner, 'content-after', {
      action: 'get_content',
    });
    const browserBusinessReadback = continuedContent.output?.includes('Browser continuation verified') === true;
    assert(browserBusinessReadback, 'Browser continuation business readback failed');
    const afterScreenshot = saveScreenshot(
      await requireBrowserSuccess(owner, 'screenshot-after', {
        action: 'screenshot',
        fullPage: true,
        analyze: false,
      }),
      join(outputDir, 'browser-after.png'),
    );
    assertions.browserContinuationReusedSession = true;
    assertions.browserContinuationBusinessReadback = true;
    assertions.realManagedBrowserAfter = afterScreenshot.bytes > 0;
    assertions.surfaceSwitchReasonsRecorded = true;

    proof.stage = 'contract-compatibility';
    const liveSnapshot = runtime.snapshotConversation(CONVERSATION_ID);
    const liveBrowser = liveSnapshot.sessions.find((candidate) => (
      candidate.session.sessionId === browserSessionId
    ));
    const liveComputer = liveSnapshot.sessions.find((candidate) => (
      candidate.session.sessionId === computerSessionId
    ));
    assert(liveBrowser && liveComputer, 'Shared control plane did not retain both Surface sessions');
    assert(
      liveBrowser.session.activeTarget?.kind === 'browser'
      && liveComputer.session.activeTarget?.kind === 'computer',
      'Browser and Computer targets were not independently typed',
    );
    assert(
      liveBrowser.session.provider === browserBinding.provider
      && liveComputer.session.provider === 'cua-driver',
      'Browser and Computer did not retain independent production providers',
    );
    assert(
      liveBrowser.session.capabilities.surface === 'browser'
      && liveBrowser.session.capabilities.observationKinds.includes('dom')
      && liveComputer.session.capabilities.surface === 'computer'
      && liveComputer.session.capabilities.observationKinds.includes('ax')
      && liveBrowser.grant.capabilities.includes('input')
      && liveBrowser.grant.dataScopes.some((scope) => scope.startsWith('tab:'))
      && liveBrowser.grant.dataScopes.every((scope) => !scope.startsWith('window:'))
      && liveComputer.grant.capabilities.includes('input')
      && liveComputer.grant.dataScopes.some((scope) => scope.startsWith('window:'))
      && liveComputer.grant.dataScopes.every((scope) => !scope.startsWith('tab:')),
      'Browser and Computer grants were not independently scoped',
    );
    assert(
      computerPermissionRequests.length === 1
      && computerPermissionRequests[0]?.surface === 'computer'
      && computerPermissionRequests[0]?.windowRef === liveComputer.session.activeTarget.windowRef,
      'Computer input did not cross the exact owned target permission boundary once',
    );
    const routedEvents = owner.events.filter(isSurfaceExecutionEventV1);
    assert(
      routedEvents.some((event) => event.surface === 'browser' && event.sessionId === browserSessionId)
      && routedEvents.some((event) => event.surface === 'computer' && event.sessionId === computerSessionId),
      'SurfaceExecutionEventV1 did not route both Browser and Computer runtime events',
    );
    assertions.surfaceContractRoutedBrowserAndComputer = true;
    assertions.sharedControlPlaneAndIndependentBoundaries = true;
    evidence.controlPlaneBeforeCleanup = {
      browser: liveBrowser,
      computer: liveComputer,
      routedEventCount: routedEvents.length,
      computerPermissionRequests,
    };

    const legacyToolCallId = 'legacy-cross-surface-browser-readback';
    const projectedLegacy = attachSurfaceExecutionResultProjection({
      toolName: 'browser_action',
      arguments: { action: 'get_content' },
      result: {
        success: continuedContent.success,
        output: continuedContent.output,
        metadata: {},
      },
      conversationId: CONVERSATION_ID,
      runId: RUN_ID,
      turnId: 'turn-cross-surface',
      agentId: OWNER_AGENT_ID,
      toolCallId: legacyToolCallId,
      startedAt: Date.now() - 1,
      completedAt: Date.now(),
    });
    assert(
      projectedLegacy.metadata?.surfaceProjectionMode === 'compatibility'
      && isSurfaceExecutionEventV1(projectedLegacy.metadata.surfaceExecutionEventV1),
      'Legacy Browser result did not produce a readable compatibility projection',
    );
    const legacyMessage: Message = {
      id: 'legacy-cross-surface-message',
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      toolResults: [{
        toolCallId: legacyToolCallId,
        success: projectedLegacy.success,
        ...(projectedLegacy.output ? { output: projectedLegacy.output } : {}),
        ...(projectedLegacy.error ? { error: projectedLegacy.error } : {}),
        metadata: projectedLegacy.metadata,
      }],
    };
    const legacySession = {
      id: CONVERSATION_ID,
      title: 'Cross Surface legacy projection acceptance',
      modelConfig: { provider: 'openai', model: 'legacy-compatibility-fixture' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [legacyMessage],
      todos: [],
      messageCount: 1,
    } as SessionWithMessages;
    const projectionService = new SurfaceConversationProjectionService({
      runtime,
      sessionStore: {
        async getSession(conversationId) {
          return conversationId === CONVERSATION_ID ? legacySession : null;
        },
        async patchSessionMetadata() {
          return true;
        },
      },
      persistEvents: false,
    });
    let compatibilitySnapshot;
    try {
      compatibilitySnapshot = await projectionService.getSnapshot(CONVERSATION_ID);
    } finally {
      projectionService.dispose();
    }
    const compatibilitySession = compatibilitySnapshot.sessions.find((candidate) => (
      candidate.session.sessionId === `legacy-surface:${legacyToolCallId}`
    ));
    assert(
      compatibilitySession?.source === 'compat'
      && compatibilitySession.events.some((event) => event.surface === 'browser'),
      'Legacy message projection was not readable through the production conversation projector',
    );
    assertions.legacyProjectionRemainsReadable = true;
    evidence.legacyProjection = {
      mode: projectedLegacy.metadata?.surfaceProjectionMode,
      session: compatibilitySession,
    };

    proof.stage = 'cleanup';
    withoutCanary(owner.events, 'Owner Surface events');
    withoutCanary(foreign.events, 'Foreign Surface events');
    await runtime.endRun(identity);
    runEnded = true;
    const computerLockEventsAfterCleanup = runtime.events.listOwned(computerPrepared.subject).filter((event) => (
      event.operation?.action === 'computer_input_lock_acquire'
      || event.operation?.action === 'computer_input_lock_release'
    ));
    assert(
      computerLockEventsAfterCleanup.some((event) => (
        event.operation?.action === 'computer_input_lock_release' && event.status === 'succeeded'
      )),
      'Computer cleanup did not expose a successful production lock release event',
    );
    assert(
      !existsSync(process.env.CODE_AGENT_CU_LOCK_PATH || ''),
      'Production Computer input lock remained after endRun cleanup',
    );
    assertions.computerInputLockLifecycleVerified = true;
    evidence.computerCleanup = {
      lockRemoved: true,
      lockEvents: computerLockEventsAfterCleanup,
    };
    const finalSnapshot = runtime.snapshotConversation(CONVERSATION_ID);
    const cleanupCompleted = finalSnapshot.sessions.length >= 3
      && finalSnapshot.sessions.every((candidate) => candidate.session.state === 'completed')
      && !adapter.getBrowserService(identity).isRunning()
      && !adapter.getBrowserService({ ...identity, agentId: FOREIGN_AGENT_ID }).isRunning()
      && !existsSync(process.env.CODE_AGENT_CU_LOCK_PATH || '');
    assert(cleanupCompleted, 'Cross-Surface sessions or provider resources remained after cleanup');
    assert(
      recordingPort.calls.some((call) => call.toolName === 'end_session' && call.forwarded),
      'Computer provider cleanup did not forward end_session',
    );
    await client.disconnect(CUA_DRIVER_SERVER_NAME);
    await client.removeServer(CUA_DRIVER_SERVER_NAME);
    serverAdded = false;
    mcpDisconnected = true;
    assertions.cleanupCompleted = true;
    assertions.computerProviderCleanupForwarded = true;
    assertions.mcpDisconnected = true;

    assertCrossSurfaceAcceptanceInvariants({
      browserSessionId,
      computerSessionId,
      computerParentSessionId: computerPrepared.session.parentSessionId,
      computerSwitchFromSessionId: toComputerEvent.operation?.approvalScope?.replace(/^from:/, ''),
      browserSwitchFromSessionId: toBrowserEvent.operation?.approvalScope?.replace(/^from:/, ''),
      browserContinuationSessionId: browserReactivated.session.sessionId,
      ownerIsolationBlocked,
      browserBusinessReadback,
      cleanupCompleted,
      permission,
      computerMutationAttempted,
      computerMutationForwarded,
    });
    const allEvents = [...owner.events, ...foreign.events];
    const switchEvidence = [toComputerEvent, toBrowserEvent].map((event) => ({
      eventId: event.eventId,
      sessionId: event.sessionId,
      parentSessionId: event.sessionId === computerSessionId
        ? computerPrepared.session.parentSessionId
        : computerSessionId,
      userSummary: event.userSummary,
      operation: event.operation,
    }));
    evidence.browser = {
      fixtureOrigin: fixture.baseUrl,
      sessionId: browserSessionId,
      beforeReadback: 'Browser ready before Computer probe',
      afterReadback: 'Browser continuation verified',
      beforeScreenshot,
      afterScreenshot,
    };
    evidence.sessions = finalSnapshot.sessions.map((candidate) => ({
      session: candidate.session,
      eventCount: candidate.events.length,
    }));
    evidence.switchEvents = switchEvidence;
    evidence.eventCount = allEvents.length;
    evidence.redactionCanary = { injected: true, sha256: sha256(CANARY), rawPersisted: false };
    assertions.parentSessionLinked = true;
    assertions.ownerIsolationBlocked = true;
    assertions.redactionCanaryAbsent = true;
    proof.externalBlock = externalBlock;
    proof.status = externalBlock ? 'blocked' : 'passed';
    proof.stage = externalBlock ? 'computer-permission' : 'complete';
    status = externalBlock ? 'blocked' : 'passed';
  } catch (error) {
    failure = errorMessage(error);
    if (error instanceof AcceptanceExternalBlockedError) {
      const computerMutationAttempted = recordingPort.calls.filter((call) => call.mutating).length;
      const computerMutationForwarded = recordingPort.calls.filter((call) => (
        call.mutating && call.forwarded
      )).length;
      assert(computerMutationAttempted === 0, 'External Computer block followed a mutation attempt');
      assert(computerMutationForwarded === 0, 'External Computer block followed a forwarded mutation');
      assertions.computerMutationAttemptedZero = true;
      assertions.computerMutationForwardedZero = true;
      proof.status = 'blocked';
      proof.stage = 'computer-permission';
      proof.blockClassification = 'blocked_external';
      proof.externalBlock = {
        code: 'COMPUTER_PERMISSION_REQUIRED',
        message: failure,
        missing: error.missing,
        userActionRequired: true,
      };
      evidence.providerCalls = recordingPort.calls;
      status = 'blocked';
    } else {
      proof.status = 'failed';
      proof.stage = String(proof.stage || 'failed');
      proof.failure = {
        code: 'CROSS_SURFACE_ACCEPTANCE_FAILED',
        message: failure,
        userActionRequired: false,
      };
      status = 'failed';
    }
  } finally {
    if (!runEnded) {
      try {
        await runtime.endRun(identity);
        runEnded = true;
        assertions.failClosedEndRun = true;
      } catch (cleanupError) {
        assertions.failClosedEndRun = false;
        evidence.endRunCleanupError = errorMessage(cleanupError);
      }
    }
    if (serverAdded) {
      try {
        await client.disconnect(CUA_DRIVER_SERVER_NAME);
        await client.removeServer(CUA_DRIVER_SERVER_NAME);
        mcpDisconnected = true;
      } catch (disconnectError) {
        evidence.mcpDisconnectError = errorMessage(disconnectError);
      }
    }
    try {
      await stopTargetFixture(computerFixture);
      assertions.computerFixtureTerminated = computerFixture
        ? computerFixture.process.exitCode !== null || computerFixture.process.killed
        : true;
    } catch (fixtureError) {
      assertions.computerFixtureTerminated = false;
      evidence.computerFixtureCleanupError = errorMessage(fixtureError);
    }
    if (computerFixture?.stderr()) evidence.computerFixtureStderr = computerFixture.stderr();
    if (fixture) await closeServer(fixture.server).catch(() => undefined);
    registry.clear();
    resetManagedBrowserProviderAdapterForTests();
    resetSurfaceExecutionRuntimeForTests();
    resetApplicationRunRegistryForTests();
    rmSync(tempRoot, { recursive: true, force: true });
    assertions.mcpDisconnected = mcpDisconnected;
    proof.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
    proof.recordedAt = new Date().toISOString();
    withoutCanary(proof, 'Cross-Surface proof');
    writeFileSync(join(outputDir, 'proof.json'), `${JSON.stringify(proof, null, 2)}\n`, 'utf8');
  }

  const result = {
    ok: status === 'passed',
    status,
    classification: status === 'blocked' ? 'blocked_external' : status,
    stage: proof.stage,
    outputDir,
    proofPath: join(outputDir, 'proof.json'),
    failure,
    assertions,
  };
  if (hasFlag(args, 'json')) printJson(result);
  else printKeyValue('Surface Execution Cross-Surface Acceptance', [
    ['ok', result.ok],
    ['status', status],
    ['classification', result.classification],
    ['stage', String(proof.stage)],
    ['outputDir', outputDir],
    ['proofPath', result.proofPath],
    ['failure', failure],
  ]);
  if (status === 'blocked') process.exitCode = 2;
  else if (status === 'failed') process.exitCode = 1;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
