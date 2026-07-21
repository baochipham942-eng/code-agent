import { createHash } from 'node:crypto';
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcessByStdio,
} from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { CuaMcpDriverPort } from '../../src/host/mcp/cuaMcpDriverPort.ts';
import {
  CuaStateAdapter,
  type CuaDriverCallContext,
  type CuaDriverCallResult,
  type CuaDriverPort,
} from '../../src/host/mcp/cuaStateAdapter.ts';
import { getDefaultMCPServers } from '../../src/host/mcp/mcpDefaultServers.ts';
import { getMCPClient } from '../../src/host/mcp/mcpClient.ts';
import {
  subscribeCuaInputLockLifecycle,
  type CuaInputLockLifecycleEvent,
} from '../../src/host/mcp/cuaSessionLock.ts';
import { CUA_DRIVER_SERVER_NAME } from '../../src/host/mcp/types.ts';
import { CuaStatefulComputerUseHandler } from '../../src/host/plugins/builtin/computerUse/cuaStatefulComputerUse.ts';
import type {
  CanUseToolFn,
  ToolContext,
  ToolResult,
} from '../../src/host/protocol/tools.ts';
import { RunRegistry } from '../../src/host/runtime/runRegistry.ts';
import {
  SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from '../../src/host/services/surfaceExecution/SurfaceExecutionRuntime.ts';
import type {
  ComputerUseRootRefV1,
  ComputerUseStateViewV1,
} from '../../src/shared/contract/desktop.ts';
import type { SurfaceExecutionEventV1 } from '../../src/shared/contract/surfaceExecution.ts';
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

const CONVERSATION_ID = 'surface-computer-acceptance';
const RUN_ID = 'surface-computer-run';
const OWNER_AGENT_ID = 'computer-agent-alpha';
const FOREIGN_AGENT_ID = 'computer-agent-beta';
const TARGET_APP = 'NeoSurfaceComputerFixture';
const TARGET_WINDOW_TITLE = 'Neo Surface Computer Acceptance';
const TARGET_FIELD_LABEL = 'Neo Surface Business Input';
const BUSINESS_VALUE = 'surface-business-readback-v1';
const BACKGROUND_BUSINESS_VALUE = 'surface-background-business-readback-v1';
const FOREGROUND_SENTINEL_TITLE = 'Neo Surface Foreground Sentinel';
const CONTENDER_SURFACE_SESSION_ID = 'surface-computer-input-lock-contender';
const TAKEOVER_BLOCKED_VALUE = 'takeover-must-not-reach-provider';
const STOP_BLOCKED_VALUE = 'stop-must-not-reach-provider';
const CANARY = 'surface-secret-canary-computer-e2e';
const CONTROL_GATE_MS = 2_000;
const MUTATING_TOOLS = new Set([
  'click',
  'double_click',
  'right_click',
  'set_value',
  'type_text',
  'press_key',
  'hotkey',
  'scroll',
  'drag',
]);

type TargetProcess = ChildProcessByStdio<null, Readable, Readable>;
type AcceptanceStatus = 'passed' | 'blocked' | 'failed';

class AcceptanceBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptanceBlockedError';
  }
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
  deliveryMode?: 'background' | 'foreground';
  forwarded: boolean;
  interruptedBeforeForward?: boolean;
  providerSucceeded?: boolean;
}

interface DelayGate {
  label: string;
  entered: Promise<void>;
  enter: () => void;
  release: () => void;
  released: Promise<void>;
}

interface TargetFixture {
  process: TargetProcess;
  binaryPath: string;
  statePath: string;
  stderr: () => string;
}

interface WindowZIndexDiagnostic {
  target: { pid: number; windowId: number; zIndex: number };
  sentinel: { pid: number; windowId: number; zIndex: number };
  targetHigherZIndex: boolean;
}

interface SystemFrontmostEvidence {
  expectedPid: number;
  expectedActive: boolean;
  activePid: number;
  activeName: string;
  commands: CommandEvidence[];
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

function usage(): void {
  console.log(`Surface Execution Computer acceptance

Usage:
  npm run acceptance:surface-execution-computer -- [options]

Options:
  --out <directory>     Persist proof, helper/TCC evidence, and current screenshots.
  --helper <binary>     Override the signed Agent Neo Computer Use helper binary.
  --json                Print JSON only.
  --help                Show this help.

The smoke verifies the signed cua-driver helper and prompt-free TCC status before
opening a controlled Cocoa fixture. Missing permissions produce a structured,
non-zero, fail-closed proof without attempting desktop mutation.`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function gitSha(ref: string): string {
  return execFileSync('git', ['rev-parse', ref], {
    cwd: process.cwd(),
    encoding: 'utf8',
  }).trim();
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

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function withoutCanary(value: unknown, label: string): void {
  assert(!JSON.stringify(value).includes(CANARY), `${label} leaked the redaction canary`);
}

function parseStructured(result: CuaDriverCallResult): Record<string, unknown> {
  if (result.structured) return result.structured;
  if (!result.output) return {};
  try {
    const parsed: unknown = JSON.parse(result.output);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function dataUrlFromResult(result: ToolResult<string>): string | null {
  const value = result.meta?.imageBase64;
  return typeof value === 'string' && value.startsWith('data:image/') ? value : null;
}

function saveDataUrl(dataUrl: string, target: string): {
  path: string;
  sha256: string;
  bytes: number;
} {
  const comma = dataUrl.indexOf(',');
  assert(comma > 0 && dataUrl.slice(0, comma).includes(';base64'), 'Screenshot data URL is invalid');
  const data = Buffer.from(dataUrl.slice(comma + 1), 'base64');
  assert(data.length > 0, 'Screenshot data URL decoded to zero bytes');
  writeFileSync(target, data);
  return { path: target, sha256: sha256(data), bytes: data.length };
}

function parseHandlerResponse(result: ToolResult<string>, label: string): StatefulResponse {
  assert(result.ok, `${label} failed: ${result.ok ? '' : `${result.code || 'unknown'} ${result.error}`}`);
  try {
    return JSON.parse(result.output) as StatefulResponse;
  } catch {
    throw new Error(`${label} returned non-JSON output`);
  }
}

function resultCode(result: ToolResult<string>): string | null {
  return result.ok ? null : result.code || null;
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
  NSRect frame = NSMakeRect(0, 0, 430, 190);
  self.window = [[NSWindow alloc]
    initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
    backing:NSBackingStoreBuffered
    defer:NO];
  [self.window setTitle:@"${TARGET_WINDOW_TITLE}"];
  [self.window center];

  NSView *content = [[NSView alloc] initWithFrame:frame];
  [self.window setContentView:content];

  NSTextField *title = [NSTextField labelWithString:@"Neo Surface Computer Fixture"];
  [title setFrame:NSMakeRect(24, 132, 360, 24)];
  [content addSubview:title];

  self.inputField = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 82, 350, 30)];
  [self.inputField setPlaceholderString:@"Business readback value"];
  [self.inputField setAccessibilityLabel:@"${TARGET_FIELD_LABEL}"];
  [self.inputField setAccessibilityIdentifier:@"neo-surface-business-input"];
  [content addSubview:self.inputField];

  NSTextField *status = [NSTextField labelWithString:@"Controlled acceptance fixture"];
  [status setFrame:NSMakeRect(24, 46, 350, 22)];
  [content addSubview:status];

  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [NSTimer scheduledTimerWithTimeInterval:0.05
    target:self
    selector:@selector(writeCurrentState:)
    userInfo:nil
    repeats:YES];
  [self writeCurrentState:nil];
}
- (void)writeCurrentState:(NSTimer *)timer {
  NSString *state = [NSString stringWithFormat:@"value=%@", [self.inputField stringValue]];
  [state writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSString *statePath = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"/tmp/neo-surface-computer-fixture-state.txt";
    AppDelegate *delegate = [[AppDelegate alloc] initWithStatePath:statePath];
    [app setDelegate:delegate];
    [app run];
  }
  return 0;
}
`;
}

function makeForegroundSentinelSource(): string {
  return `#import <Cocoa/Cocoa.h>

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property(nonatomic, copy) NSString *statePath;
@property(nonatomic, retain) NSWindow *window;
@end

@implementation AppDelegate
- (instancetype)initWithStatePath:(NSString *)statePath {
  self = [super init];
  if (self) self.statePath = statePath;
  return self;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(0, 0, 360, 120);
  self.window = [[NSWindow alloc]
    initWithContentRect:frame
    styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable)
    backing:NSBackingStoreBuffered
    defer:NO];
  [self.window setTitle:@"${FOREGROUND_SENTINEL_TITLE}"];
  [self.window center];
  NSTextField *label = [NSTextField labelWithString:@"Foreground sentinel for Computer acceptance"];
  [label setFrame:NSMakeRect(24, 48, 310, 24)];
  [[self.window contentView] addSubview:label];
  [@"ready" writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
  [self.window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}
- (BOOL)applicationShouldTerminateAfterLastWindowClosed:(NSApplication *)sender {
  return YES;
}
@end

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSString *statePath = argc > 1
      ? [NSString stringWithUTF8String:argv[1]]
      : @"/tmp/neo-surface-foreground-sentinel.txt";
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

async function startTargetFixture(tmpRoot: string): Promise<TargetFixture> {
  const sourcePath = join(tmpRoot, `${TARGET_APP}.m`);
  const appPath = join(tmpRoot, `${TARGET_APP}.app`);
  const contentsPath = join(appPath, 'Contents');
  const executableDir = join(contentsPath, 'MacOS');
  const binaryPath = join(executableDir, TARGET_APP);
  const statePath = join(tmpRoot, 'fixture-state.txt');
  mkdirSync(executableDir, { recursive: true });
  writeFileSync(join(contentsPath, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>${TARGET_APP}</string>
  <key>CFBundleIdentifier</key><string>com.agentneo.surface-computer-fixture</string>
  <key>CFBundleName</key><string>${TARGET_APP}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
`, 'utf8');
  writeFileSync(sourcePath, makeTargetSource(), 'utf8');
  execFileSync('clang', [sourcePath, '-o', binaryPath, '-framework', 'Cocoa'], {
    cwd: tmpRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const child = spawn(binaryPath, [statePath], {
    cwd: tmpRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const ready = await waitFor(() => readFixtureState(statePath) === 'value=', 10_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Controlled fixture did not become ready: ${readFixtureState(statePath) || 'missing'} ${stderr}`);
  }
  assert(typeof child.pid === 'number', 'Controlled fixture process has no pid');
  return { process: child, binaryPath, statePath, stderr: () => stderr };
}

async function startForegroundSentinel(tmpRoot: string, sequence: number): Promise<TargetFixture> {
  const sourcePath = join(tmpRoot, `NeoSurfaceForegroundSentinel-${sequence}.m`);
  const binaryPath = join(tmpRoot, `NeoSurfaceForegroundSentinel-${sequence}`);
  const statePath = join(tmpRoot, `foreground-sentinel-${sequence}.txt`);
  writeFileSync(sourcePath, makeForegroundSentinelSource(), 'utf8');
  execFileSync('clang', [sourcePath, '-o', binaryPath, '-framework', 'Cocoa'], {
    cwd: tmpRoot,
    timeout: 20_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const child = spawn(binaryPath, [statePath], {
    cwd: tmpRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => {
    stderr = `${stderr}${String(chunk)}`.slice(-16_384);
  });
  const ready = await waitFor(() => readFixtureState(statePath) === 'ready', 10_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Foreground sentinel did not become ready: ${stderr || 'missing state'}`);
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

function createGate(label: string): DelayGate {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolveEntered) => { enter = resolveEntered; });
  const released = new Promise<void>((resolveReleased) => { release = resolveReleased; });
  return { label, entered, enter, release, released };
}

class ControlledCuaDriverPort implements CuaDriverPort {
  readonly calls: DriverCallEvidence[] = [];
  private gate: DelayGate | null = null;
  private afterForwardGate: DelayGate | null = null;

  constructor(private readonly delegate: CuaDriverPort) {}

  armMutationGate(label: string): DelayGate {
    assert(!this.gate, `A mutation gate is already armed: ${this.gate?.label}`);
    this.gate = createGate(label);
    return this.gate;
  }

  armAfterForwardMutationGate(label: string): DelayGate {
    assert(
      !this.afterForwardGate,
      `An after-forward mutation gate is already armed: ${this.afterForwardGate?.label}`,
    );
    this.afterForwardGate = createGate(label);
    return this.afterForwardGate;
  }

  releaseGate(): void {
    this.gate?.release();
    this.gate = null;
    this.afterForwardGate?.release();
    this.afterForwardGate = null;
  }

  forwardedMutationCount(): number {
    return this.calls.filter((call) => MUTATING_TOOLS.has(call.toolName) && call.forwarded).length;
  }

  succeededMutationCount(): number {
    return this.calls.filter((call) => (
      MUTATING_TOOLS.has(call.toolName) && call.providerSucceeded === true
    )).length;
  }

  async call(
    toolName: string,
    args: Record<string, unknown>,
    context: CuaDriverCallContext,
  ): Promise<CuaDriverCallResult> {
    const evidence: DriverCallEvidence = {
      toolName,
      at: new Date().toISOString(),
      ...(context.surfaceSessionId ? { surfaceSessionId: context.surfaceSessionId } : {}),
      ...(args.delivery_mode === 'background' || args.delivery_mode === 'foreground'
        ? { deliveryMode: args.delivery_mode }
        : {}),
      forwarded: false,
    };
    this.calls.push(evidence);
    const gate = this.gate;
    if (gate && MUTATING_TOOLS.has(toolName)) {
      this.gate = null;
      gate.enter();
      const interrupted = await new Promise<boolean>((resolveInterrupted) => {
        const onAbort = () => resolveInterrupted(true);
        if (context.abortSignal?.aborted) {
          resolveInterrupted(true);
          return;
        }
        context.abortSignal?.addEventListener('abort', onAbort, { once: true });
        void gate.released.then(() => {
          context.abortSignal?.removeEventListener('abort', onAbort);
          resolveInterrupted(false);
        });
      });
      if (interrupted) {
        evidence.interruptedBeforeForward = true;
        return { success: false, error: `${gate.label} interrupted before provider dispatch` };
      }
    }
    evidence.forwarded = true;
    const result = await this.delegate.call(toolName, args, context);
    evidence.providerSucceeded = result.success;
    const afterForwardGate = this.afterForwardGate;
    if (afterForwardGate && MUTATING_TOOLS.has(toolName)) {
      this.afterForwardGate = null;
      afterForwardGate.enter();
      await afterForwardGate.released;
    }
    return result;
  }

  getGeneration(): string | undefined {
    return this.delegate.getGeneration();
  }
}

function logger(): ToolContext['logger'] {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

function makeIdentity(events: SurfaceExecutionEventV1[]): SurfaceRuntimeIdentityV1 {
  return {
    conversationId: CONVERSATION_ID,
    runId: RUN_ID,
    turnId: 'turn-computer-acceptance',
    agentId: OWNER_AGENT_ID,
    emitSurfaceEvent(event) {
      events.push(event);
    },
  };
}

function makeContext(input: {
  agentId: string;
  callId: string;
  events: SurfaceExecutionEventV1[];
  signal?: AbortSignal;
}): ToolContext {
  return {
    runId: RUN_ID,
    turnId: `turn-${input.agentId}`,
    sessionId: CONVERSATION_ID,
    workspace: process.cwd(),
    workingDir: process.cwd(),
    abortSignal: input.signal || new AbortController().signal,
    agentId: input.agentId,
    currentToolCallId: input.callId,
    logger: logger(),
    emit(event) {
      const candidate = event as { type?: string; data?: unknown };
      if (candidate.type === 'surface_execution' && candidate.data) {
        input.events.push(candidate.data as SurfaceExecutionEventV1);
      }
    },
  };
}

function stateFromObserve(result: ToolResult<string>, label: string): ComputerUseStateViewV1 {
  const response = parseHandlerResponse(result, label);
  assert(response.operation === 'observe' && response.state, `${label} did not return an observation`);
  return response.state;
}

function surfaceSessionId(result: ToolResult<string>, label: string): string {
  const session = result.meta?.surfaceExecutionSessionV1 as { sessionId?: unknown } | undefined;
  assert(typeof session?.sessionId === 'string', `${label} did not return a Surface Session id`);
  return session.sessionId;
}

function findInputRef(state: ComputerUseStateViewV1): string {
  const exact = state.elements.find((element) => element.label === TARGET_FIELD_LABEL);
  const field = exact || state.elements.find((element) => /textfield|text field/i.test(element.role));
  assert(field, `Observation did not include the fixture text field; roles=${state.elements
    .map((element) => `${element.role}:${element.label || ''}`)
    .join(',')}`);
  return field.ref;
}

async function waitForRoot(
  handler: CuaStatefulComputerUseHandler,
  processId: number,
  expectedTitle: string,
  events: SurfaceExecutionEventV1[],
  canUseTool: CanUseToolFn,
): Promise<ComputerUseRootRefV1> {
  let sequence = 0;
  let lastRoots: ComputerUseRootRefV1[] = [];
  const found = await waitFor(async () => {
    sequence += 1;
    const listed = await handler.execute({
      operation: 'list_roots',
      onScreenOnly: false,
    }, makeContext({
      agentId: OWNER_AGENT_ID,
      callId: `list-roots-${sequence}`,
      events,
    }), canUseTool);
    const response = parseHandlerResponse(listed, `list_roots ${sequence}`);
    lastRoots = response.roots || [];
    return lastRoots.some((root) => root.pid === processId && root.title === expectedTitle);
  }, 10_000, 250);
  assert(found, `cua-driver did not list ${processId}:${expectedTitle}; roots=${lastRoots
    .filter((root) => root.pid === processId)
    .map((root) => `${root.pid}:${root.windowId}:${root.appName || ''}:${root.title || ''}:${JSON.stringify(root.bounds || null)}`)
    .join(',')}`);
  return lastRoots.find((root) => (
    root.pid === processId && root.title === expectedTitle
  )) as ComputerUseRootRefV1;
}

async function windowOrderEvidence(input: {
  port: ControlledCuaDriverPort;
  target: ComputerUseRootRefV1;
  sentinel: ComputerUseRootRefV1;
  surfaceSessionId: string;
  callId: string;
}): Promise<WindowZIndexDiagnostic> {
  const result = await input.port.call('list_windows', { on_screen_only: false }, {
    sessionId: CONVERSATION_ID,
    surfaceSessionId: input.surfaceSessionId,
    runId: RUN_ID,
    agentId: OWNER_AGENT_ID,
    toolCallId: input.callId,
    abortSignal: new AbortController().signal,
  });
  assert(result.success, `Real helper window-order query failed: ${result.error || result.output || 'unknown'}`);
  const structured = parseStructured(result);
  const windows = Array.isArray(structured.windows)
    ? structured.windows.filter((window): window is Record<string, unknown> => (
        Boolean(window) && typeof window === 'object' && !Array.isArray(window)
      ))
    : [];
  const read = (root: ComputerUseRootRefV1) => {
    const window = windows.find((candidate) => (
      candidate.pid === root.pid
      && (candidate.window_id === root.windowId || candidate.windowId === root.windowId)
    ));
    const zIndex = window?.z_index ?? window?.zIndex;
    assert(window && typeof zIndex === 'number' && Number.isFinite(zIndex), (
      `Real helper omitted z_index for ${root.pid}:${root.windowId}`
    ));
    return { pid: root.pid, windowId: root.windowId, zIndex };
  };
  const target = read(input.target);
  const sentinel = read(input.sentinel);
  return {
    target,
    sentinel,
    targetHigherZIndex: target.zIndex > sentinel.zIndex,
  };
}

async function bringToFront(input: {
  port: ControlledCuaDriverPort;
  root: ComputerUseRootRefV1;
  surfaceSessionId: string;
  callId: string;
}): Promise<{ providerSucceeded: true; output: string | null }> {
  const result = await input.port.call('bring_to_front', {
    pid: input.root.pid,
    window_id: input.root.windowId,
  }, {
    sessionId: CONVERSATION_ID,
    surfaceSessionId: input.surfaceSessionId,
    runId: RUN_ID,
    agentId: OWNER_AGENT_ID,
    toolCallId: input.callId,
    abortSignal: new AbortController().signal,
  });
  assert(
    result.success,
    `Real helper bring_to_front failed for ${input.root.pid}:${input.root.windowId}: ${result.error || result.output || 'unknown'}`,
  );
  return { providerSucceeded: true, output: result.output || null };
}

function systemFrontmostEvidence(expectedPid: number): SystemFrontmostEvidence {
  const front = runEvidence('/usr/bin/lsappinfo', ['front']);
  assert(front.exitCode === 0 && front.stdout.trim(), `Could not read macOS front ASN: ${front.stderr}`);
  const info = runEvidence('/usr/bin/lsappinfo', [
    'info',
    '-only',
    'pid,name',
    front.stdout.trim(),
  ]);
  assert(info.exitCode === 0, `Could not resolve macOS frontmost process: ${info.stderr}`);
  const activePid = Number.parseInt(info.stdout.match(/^"pid"=(\d+)$/m)?.[1] || '', 10);
  assert(Number.isInteger(activePid) && activePid > 0, `Invalid frontmost pid: ${info.stdout}`);
  return {
    expectedPid,
    expectedActive: activePid === expectedPid,
    activePid,
    activeName: info.stdout.match(/^"LSDisplayName"="(.*)"$/m)?.[1] || 'unknown',
    commands: [front, info],
  };
}

async function waitForSystemFrontmost(input: {
  expectedPid: number;
}): Promise<SystemFrontmostEvidence> {
  let observed: SystemFrontmostEvidence | null = null;
  const matched = await waitFor(async () => {
    observed = systemFrontmostEvidence(input.expectedPid);
    return observed.expectedActive;
  }, 5_000, 200);
  assert(
    matched && observed,
    `macOS did not report the expected frontmost app after helper activation: ${JSON.stringify(observed)}`,
  );
  return observed;
}

function lockOwner(lockPath: string): string | null {
  if (!existsSync(lockPath)) return null;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { sessionId?: unknown };
    return typeof parsed.sessionId === 'string' ? parsed.sessionId : null;
  } catch {
    return null;
  }
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

function permissionDecision(structured: Record<string, unknown>, expectedHelperPath: string): {
  ready: boolean;
  accessibility: boolean;
  screenRecording: boolean;
  screenRecordingCapturable: boolean;
  source: string;
  sourceExecutable: string | null;
  sourceTrusted: boolean;
  inputMonitoring: 'not_reported_not_required_for_ax_set_value';
  missing: string[];
} {
  const accessibility = structured.accessibility === true;
  const screenRecording = structured.screen_recording === true;
  const screenRecordingCapturable = structured.screen_recording_capturable === true;
  const sourceRecord = structured.source && typeof structured.source === 'object'
    && !Array.isArray(structured.source)
    ? structured.source as Record<string, unknown>
    : null;
  const source = typeof structured.source === 'string'
    ? structured.source
    : typeof sourceRecord?.attribution === 'string'
      ? sourceRecord.attribution
      : 'unknown';
  const sourceExecutable = typeof sourceRecord?.executable === 'string'
    ? sourceRecord.executable
    : null;
  const sourceTrusted = (/daemon|agentneo|com\.agentneo/i.test(source)
    && !/terminal|shell/i.test(source))
    || Boolean(sourceExecutable && resolve(sourceExecutable) === resolve(expectedHelperPath));
  const missing = [
    ...(!accessibility ? ['accessibility'] : []),
    ...(!screenRecording ? ['screen_recording'] : []),
    ...(!screenRecordingCapturable ? ['screen_recording_capturable'] : []),
    ...(!sourceTrusted ? ['trusted_helper_tcc_identity'] : []),
  ];
  return {
    ready: missing.length === 0,
    accessibility,
    screenRecording,
    screenRecordingCapturable,
    source,
    sourceExecutable,
    sourceTrusted,
    inputMonitoring: 'not_reported_not_required_for_ax_set_value',
    missing,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(
      () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    )),
  ]);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  const campaignProof = surfaceAcceptanceCampaignProofFields();
  if (process.platform !== 'darwin') throw new Error('Stateful Computer acceptance requires macOS.');

  const outputDir = resolve(getStringOption(args, 'out')
    || mkdtempSync(join(tmpdir(), 'surface-execution-computer-proof-')));
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
  const tmpRoot = mkdtempSync(join(tmpdir(), 'surface-execution-computer-fixture-'));
  const lockPath = join(tmpRoot, 'computer-use.lock');
  process.env.CODE_AGENT_ENABLE_CUA = '1';
  process.env.CODE_AGENT_CUA_STATE_V2 = '1';
  process.env.CODE_AGENT_CUA_DRIVER_PATH = helperPath;
  process.env.CODE_AGENT_CU_LOCK_PATH = lockPath;

  const proof: Record<string, unknown> = {
    version: 1,
    status: 'failed' satisfies AcceptanceStatus,
    ...campaignProof,
    stage: 'helper',
    recordedAt: new Date().toISOString(),
    worktree: process.cwd(),
    head: gitSha('HEAD'),
    originMain: gitSha('origin/main'),
    mergeBase: execFileSync('git', ['merge-base', 'HEAD', 'origin/main'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim(),
    sourceFingerprint: surfaceAcceptanceSourceFingerprint(),
    invocation: ['npm', 'run', 'acceptance:surface-execution-computer', '--', ...process.argv.slice(2)],
    helper: { path: helperPath, app: helperApp },
    assertions: {},
    evidence: {},
  };
  const assertions = proof.assertions as Record<string, unknown>;
  const evidence = proof.evidence as Record<string, unknown>;
  const client = getMCPClient();
  const directPort = new CuaMcpDriverPort();
  const controlledPort = new ControlledCuaDriverPort(directPort);
  const registry = new RunRegistry();
  const runtime = new SurfaceExecutionRuntime({ runRegistry: registry });
  const adapter = new CuaStateAdapter(controlledPort);
  const handler = new CuaStatefulComputerUseHandler(adapter, runtime);
  const events: SurfaceExecutionEventV1[] = [];
  const inputLockLifecycle: CuaInputLockLifecycleEvent[] = [];
  const unsubscribeInputLockLifecycle = subscribeCuaInputLockLifecycle((event) => {
    inputLockLifecycle.push(structuredClone(event));
  });
  const identity = makeIdentity(events);
  const permissionRequests: Array<Record<string, unknown>> = [];
  const canUseTool: CanUseToolFn = async (_toolName, input) => {
    const surfaceTarget = input.surfaceTarget as Record<string, unknown> | undefined;
    permissionRequests.push({
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
  let fixture: TargetFixture | null = null;
  const foregroundSentinels: TargetFixture[] = [];
  let runStarted = false;
  let runEnded = false;
  let serverAdded = false;
  let status: AcceptanceStatus = 'failed';
  let failure: string | null = null;

  try {
    assert(existsSync(helperPath) && statSync(helperPath).isFile(), `Signed helper is missing: ${helperPath}`);
    const version = runEvidence(helperPath, ['--version']);
    const signatureVerify = runEvidence('codesign', ['--verify', '--strict', '--verbose=2', helperApp]);
    const signatureDetails = runEvidence('codesign', ['-d', '--verbose=4', helperApp]);
    evidence.helperVersionCommand = version;
    evidence.codesignVerifyCommand = signatureVerify;
    evidence.codesignDetailsCommand = signatureDetails;
    writeFileSync(join(outputDir, 'helper-version.txt'), `${version.stdout}${version.stderr}`, 'utf8');
    writeFileSync(
      join(outputDir, 'codesign.txt'),
      `${signatureVerify.stdout}${signatureVerify.stderr}${signatureDetails.stdout}${signatureDetails.stderr}`,
      'utf8',
    );
    assert(version.exitCode === 0 && version.stdout.trim() === 'cua-driver 0.8.1', `Unexpected helper version: ${version.stdout}${version.stderr}`);
    assert(signatureVerify.exitCode === 0, `codesign verification failed: ${signatureVerify.stderr}`);
    const signature = parseCodesign(`${signatureDetails.stdout}\n${signatureDetails.stderr}`);
    assert(signature.identifier === 'com.agentneo.computeruse', `Unexpected helper bundle id: ${signature.identifier}`);
    assert(signature.teamIdentifier === 'D7CVTJ72NV', `Unexpected helper team id: ${signature.teamIdentifier}`);
    assertions.helperVersion081 = true;
    assertions.helperCodesignValid = true;
    assertions.helperBundleIdentity = true;
    (proof.helper as Record<string, unknown>).version = version.stdout.trim();
    (proof.helper as Record<string, unknown>).signature = signature;

    proof.stage = 'permissions';
    const cuaServer = getDefaultMCPServers().find((server) => server.name === CUA_DRIVER_SERVER_NAME);
    assert(cuaServer?.enabled, 'cua-driver MCP server was not enabled by the acceptance environment');
    client.addServer(cuaServer);
    serverAdded = true;
    const connected = await client.ensureConnected(CUA_DRIVER_SERVER_NAME);
    assert(connected, 'Signed cua-driver helper did not establish an MCP connection');
    assertions.signedHelperMcpConnected = true;
    evidence.providerGeneration = directPort.getGeneration() || null;
    const permissionResult = await controlledPort.call('check_permissions', { prompt: false }, {
      sessionId: CONVERSATION_ID,
      surfaceSessionId: 'surface-computer-permission-probe',
      runId: RUN_ID,
      agentId: OWNER_AGENT_ID,
      toolCallId: 'computer-permission-probe',
      abortSignal: new AbortController().signal,
    });
    const permissionStructured = parseStructured(permissionResult);
    const permissions = permissionDecision(permissionStructured, helperPath);
    proof.permissions = {
      prompt: false,
      callSucceeded: permissionResult.success,
      structured: permissionStructured,
      decision: permissions,
    };
    writeJson(join(outputDir, 'permissions.json'), proof.permissions);
    assertions.permissionProbePromptFalse = true;
    assertions.permissionProbeSucceeded = permissionResult.success;
    assertions.permissionSourceTrusted = permissions.sourceTrusted;
    assertions.accessibilityGranted = permissions.accessibility;
    assertions.screenRecordingGranted = permissions.screenRecording;
    assertions.screenRecordingCapturable = permissions.screenRecordingCapturable;
    if (!permissionResult.success || !permissions.ready) {
      const computerMutationAttempted = controlledPort.calls.filter((call) => (
        MUTATING_TOOLS.has(call.toolName)
      )).length;
      const computerMutationForwarded = controlledPort.forwardedMutationCount();
      evidence.computerMutation = {
        attempted: computerMutationAttempted,
        forwarded: computerMutationForwarded,
      };
      assert(
        computerMutationAttempted === 0,
        `Computer permission block followed ${computerMutationAttempted} attempted mutation(s)`,
      );
      assert(
        computerMutationForwarded === 0,
        `Computer permission block followed ${computerMutationForwarded} forwarded mutation(s)`,
      );
      assertions.computerMutationAttemptedZero = true;
      assertions.computerMutationForwardedZero = true;
      status = 'blocked';
      proof.status = status;
      proof.stage = 'permissions';
      failure = permissionResult.error
        || permissionResult.output
        || `Missing required helper permissions: ${permissions.missing.join(', ')}`;
      proof.failure = {
        code: 'COMPUTER_PERMISSION_REQUIRED',
        message: failure,
        missing: permissions.missing,
        userActionRequired: true,
      };
      throw new AcceptanceBlockedError(failure);
    }

    proof.stage = 'fixture';
    registry.start({ runId: RUN_ID, sessionId: CONVERSATION_ID, workspace: process.cwd() });
    runStarted = true;
    const initialSentinel = await startForegroundSentinel(tmpRoot, 1);
    foregroundSentinels.push(initialSentinel);
    fixture = await startTargetFixture(tmpRoot);
    assertions.controlledFixtureStarted = true;
    evidence.fixture = {
      executableSha256: sha256(readFileSync(fixture.binaryPath)),
      pid: fixture.process.pid,
      windowTitle: TARGET_WINDOW_TITLE,
    };
    assert(typeof fixture.process.pid === 'number', 'Controlled fixture process has no pid');
    const root = await waitForRoot(
      handler,
      fixture.process.pid,
      TARGET_WINDOW_TITLE,
      events,
      canUseTool,
    );
    assert(typeof initialSentinel.process.pid === 'number', 'Initial foreground sentinel has no pid');
    const initialSentinelRoot = await waitForRoot(
      handler,
      initialSentinel.process.pid,
      FOREGROUND_SENTINEL_TITLE,
      events,
      canUseTool,
    );
    assert(
      root.pid === fixture.process.pid && Number.isInteger(root.windowId) && root.windowId > 0,
      `Fixture root identity mismatch: ${root.pid}:${root.windowId}`,
    );

    proof.stage = 'stateful-action';
    let callSequence = 0;
    const execute = (
      agentId: string,
      label: string,
      request: Record<string, unknown>,
    ) => {
      callSequence += 1;
      return handler.execute(request, makeContext({
        agentId,
        callId: `${label}-${callSequence}`,
        events,
      }), canUseTool);
    };
    const observe = (label: string) => execute(OWNER_AGENT_ID, label, {
      operation: 'observe',
      target: { pid: root.pid, windowId: root.windowId },
      query: TARGET_FIELD_LABEL,
      includeScreenshot: true,
    });
    const bootstrapObservation = await observe('session-bootstrap-observe');
    const bootstrapState = stateFromObserve(bootstrapObservation, 'session bootstrap observe');
    assert(
      bootstrapState.root.pid === root.pid && bootstrapState.root.windowId === root.windowId,
      'Session bootstrap did not preserve the real helper app/window identity',
    );
    const computerSessionId = surfaceSessionId(bootstrapObservation, 'session bootstrap observe');
    const foregroundActivation = await bringToFront({
      port: controlledPort,
      root,
      surfaceSessionId: computerSessionId,
      callId: 'computer-foreground-activate',
    });
    const foregroundFrontmost = await waitForSystemFrontmost({
      expectedPid: root.pid,
    });
    const foregroundOrder = await windowOrderEvidence({
      port: controlledPort,
      target: root,
      sentinel: initialSentinelRoot,
      surfaceSessionId: computerSessionId,
      callId: 'computer-foreground-z-order-diagnostic',
    });
    assert(
      foregroundFrontmost.expectedActive,
      `Real helper did not observe the target as frontmost: ${JSON.stringify(foregroundFrontmost)}`,
    );
    assertions.fixtureRootDiscovered = true;
    evidence.fixtureRoot = root;
    evidence.foregroundActivation = foregroundActivation;
    evidence.foregroundFrontmost = foregroundFrontmost;
    evidence.foregroundOrder = foregroundOrder;

    const initialObservation = await observe('initial-observe');
    const initialState = stateFromObserve(initialObservation, 'initial observe');
    assert(
      initialState.root.pid === root.pid && initialState.root.windowId === root.windowId,
      'Stateful observation did not preserve the real helper app/window identity',
    );
    const initialInputRef = findInputRef(initialState);
    assert(
      surfaceSessionId(initialObservation, 'initial observe') === computerSessionId,
      'Stateful observe changed the Computer Surface Session identity',
    );
    const initialImage = dataUrlFromResult(initialObservation);
    assert(initialImage, 'Initial stateful observation did not return a screenshot');
    const initialScreenshot = saveDataUrl(initialImage, join(outputDir, 'before.png'));
    evidence.initialScreenshot = initialScreenshot;
    assertions.statefulObservation = true;
    assertions.observationHasOpaqueState = initialState.stateId.startsWith('cua_');
    assertions.observationHasScreenshot = true;
    assertions.realAppObserved = initialScreenshot.bytes > 0
      && initialState.root.pid === fixture.process.pid
      && Boolean(initialState.elements.find((element) => element.ref === initialInputRef));
    assertions.foregroundObservationVerified = assertions.realAppObserved === true
      && foregroundFrontmost.expectedActive;
    evidence.realAppObservation = {
      pid: initialState.root.pid,
      windowId: initialState.root.windowId,
      windowTitle: initialState.root.title,
      inputRef: initialInputRef,
      screenshot: initialScreenshot,
      helperFrontmost: foregroundFrontmost,
      helperWindowOrder: foregroundOrder,
    };

    const permissionCountBeforeForeign = permissionRequests.length;
    const forwardedBeforeForeign = controlledPort.forwardedMutationCount();
    const foreignAct = await execute(FOREIGN_AGENT_ID, 'foreign-act', {
      operation: 'act',
      stateId: initialState.stateId,
      mutation: { kind: 'set_value', elementRef: initialInputRef, value: 'foreign-must-not-run' },
    });
    assert(!foreignAct.ok && resultCode(foreignAct) === 'SURFACE_STATE_STALE', `Cross-agent state was not rejected: ${JSON.stringify(foreignAct)}`);
    assert(permissionRequests.length === permissionCountBeforeForeign, 'Cross-agent rejection reached the permission boundary');
    assert(controlledPort.forwardedMutationCount() === forwardedBeforeForeign, 'Cross-agent rejection reached the provider');
    assert(readFixtureState(fixture.statePath) === 'value=', 'Cross-agent rejection changed fixture state');
    assertions.crossAgentStateBlocked = true;
    assertions.crossAgentBlockedBeforePermission = true;
    assertions.crossAgentBlockedBeforeProvider = true;

    const succeededBeforeBusiness = controlledPort.succeededMutationCount();
    const businessLockGate = controlledPort.armAfterForwardMutationGate('business-input-lock');
    const businessActPromise = execute(OWNER_AGENT_ID, 'business-act', {
      operation: 'act',
      stateId: initialState.stateId,
      mutation: {
        kind: 'set_value',
        elementRef: initialInputRef,
        value: BUSINESS_VALUE,
        deliveryMode: 'foreground',
      },
      expect: { kind: 'text_present', text: BUSINESS_VALUE },
      acceptanceSecretCanary: CANARY,
    });
    await withTimeout(businessLockGate.entered, CONTROL_GATE_MS, 'Business input-lock gate');

    proof.stage = 'input-lock';
    let acquiredInputLock = false;
    let blockedInputLock = false;
    try {
      assert(existsSync(lockPath), 'Real helper mutation did not acquire the Computer input lock');
      assert(
        lockOwner(lockPath) === computerSessionId,
        `Computer input lock owner was ${lockOwner(lockPath) || 'missing'}`,
      );
      acquiredInputLock = inputLockLifecycle.some((event) => (
        event.scope === computerSessionId
        && event.phase === 'acquire'
        && event.status === 'succeeded'
        && (event.outcome === 'acquired' || event.outcome === 'reentrant')
      ));
      assert(acquiredInputLock, 'Computer input lock acquisition was not observed from the real control boundary');
      const stateBeforeContention = readFixtureState(fixture.statePath);
      const contention = await controlledPort.call('set_value', {}, {
        sessionId: CONVERSATION_ID,
        surfaceSessionId: CONTENDER_SURFACE_SESSION_ID,
        runId: RUN_ID,
        agentId: FOREIGN_AGENT_ID,
        toolCallId: 'computer-input-lock-contention',
        abortSignal: new AbortController().signal,
      });
      assert(
        !contention.success && /另一个会话|input lock|session.*lock|使用计算机/i.test(
          contention.error || contention.output || '',
        ),
        `Competing Computer input was not rejected by the real lock: ${contention.error || contention.output || 'missing'}`,
      );
      assert(
        readFixtureState(fixture.statePath) === stateBeforeContention,
        'Input-lock contention changed the real fixture business state',
      );
      assert(lockOwner(lockPath) === computerSessionId, 'Input-lock contention displaced the real owner');
      blockedInputLock = inputLockLifecycle.some((event) => (
        event.scope === CONTENDER_SURFACE_SESSION_ID
        && event.phase === 'acquire'
        && event.status === 'failed'
        && event.outcome === 'blocked'
      ));
      assert(blockedInputLock, 'Competing Computer input did not emit a blocked lock lifecycle event');
      assertions.inputLockAcquired = true;
      assertions.inputLockContended = true;
      evidence.inputLock = {
        ownerScopeSha256: sha256(computerSessionId),
        contenderScopeSha256: sha256(CONTENDER_SURFACE_SESSION_ID),
        lockPresentDuringMutation: existsSync(lockPath),
        ownerPreservedAfterContention: lockOwner(lockPath) === computerSessionId,
        contentionProviderSucceeded: contention.success,
        lifecycle: inputLockLifecycle,
      };
    } finally {
      businessLockGate.release();
    }

    const businessAct = await withTimeout(businessActPromise, 10_000, 'Business Computer mutation');
    const businessResponse = parseHandlerResponse(businessAct, 'business act');
    assert(businessResponse.operation === 'act' && businessResponse.result, 'Business act returned no action result');
    assert(businessResponse.result.delivery === 'confirmed', `Business delivery was ${businessResponse.result.delivery}`);
    assert(businessResponse.result.verification === 'satisfied', `Business verification was ${businessResponse.result.verification}`);
    assert(businessResponse.result.overall === 'succeeded', `Business overall was ${businessResponse.result.overall}`);
    assert(
      controlledPort.succeededMutationCount() === succeededBeforeBusiness + 1,
      'Business mutation did not succeed through the real provider exactly once',
    );
    const foregroundProviderCall = controlledPort.calls.findLast((call) => (
      call.toolName === 'set_value'
      && call.surfaceSessionId === computerSessionId
      && call.deliveryMode === 'foreground'
    ));
    assert(
      foregroundProviderCall?.forwarded && foregroundProviderCall.providerSucceeded,
      'Foreground business mutation did not succeed through the real helper provider',
    );
    const businessReadback = await waitFor(
      () => readFixtureState(fixture?.statePath || '') === `value=${BUSINESS_VALUE}`,
      5_000,
      100,
    );
    assert(businessReadback, `Fixture business readback failed: ${readFixtureState(fixture.statePath)}`);
    const afterImage = dataUrlFromResult(businessAct);
    assert(afterImage, 'Business action did not return a successor screenshot');
    const afterScreenshot = saveDataUrl(afterImage, join(outputDir, 'after.png'));
    evidence.afterScreenshot = afterScreenshot;
    const foregroundBusinessReadback = {
      expected: `value=${BUSINESS_VALUE}`,
      actual: readFixtureState(fixture.statePath),
      sha256: sha256(readFixtureState(fixture.statePath) || ''),
    };
    evidence.businessReadback = foregroundBusinessReadback;
    const businessSuccessorValue = businessResponse.result.successorState?.elements.find((element) => (
      element.label === TARGET_FIELD_LABEL
    ))?.value;
    assert(
      businessSuccessorValue === BUSINESS_VALUE,
      `Real helper successor state read back ${businessSuccessorValue || 'missing'}`,
    );
    assertions.realProviderMutation = true;
    assertions.deliveryConfirmed = true;
    assertions.verificationSatisfied = true;
    assertions.businessReadback = true;
    assertions.realAppMutationDelivered = businessResponse.result.delivery === 'confirmed'
      && foregroundProviderCall.providerSucceeded === true
      && foregroundBusinessReadback.actual === foregroundBusinessReadback.expected;
    assertions.realAppBusinessVerified = businessResponse.result.verification === 'satisfied'
      && businessResponse.result.overall === 'succeeded'
      && businessSuccessorValue === BUSINESS_VALUE
      && afterScreenshot.bytes > 0;
    evidence.businessVerification = {
      screenshot: afterScreenshot,
      businessReadback: foregroundBusinessReadback,
      delivery: businessResponse.result.delivery,
      verification: businessResponse.result.verification,
      overall: businessResponse.result.overall,
      successorValueSha256: sha256(businessSuccessorValue),
      helperCall: foregroundProviderCall,
    };
    withoutCanary(businessAct, 'Business Stateful Computer result');

    proof.stage = 'foreground-background';
    const backgroundSentinel = await startForegroundSentinel(tmpRoot, 2);
    foregroundSentinels.push(backgroundSentinel);
    assert(typeof backgroundSentinel.process.pid === 'number', 'Background sentinel has no pid');
    const backgroundSentinelRoot = await waitForRoot(
      handler,
      backgroundSentinel.process.pid,
      FOREGROUND_SENTINEL_TITLE,
      events,
      canUseTool,
    );
    const backgroundActivation = await bringToFront({
      port: controlledPort,
      root: backgroundSentinelRoot,
      surfaceSessionId: computerSessionId,
      callId: 'computer-background-activate',
    });
    const backgroundFrontmostBefore = await waitForSystemFrontmost({
      expectedPid: backgroundSentinelRoot.pid,
    });
    const beforeBackgroundOrder = await windowOrderEvidence({
      port: controlledPort,
      target: root,
      sentinel: backgroundSentinelRoot,
      surfaceSessionId: computerSessionId,
      callId: 'computer-background-z-order-before',
    });
    assert(
      backgroundFrontmostBefore.expectedActive,
      `Real helper did not observe the sentinel as frontmost: ${JSON.stringify(backgroundFrontmostBefore)}`,
    );
    const backgroundObservation = await observe('background-observe');
    const backgroundState = stateFromObserve(backgroundObservation, 'background observe');
    const backgroundInputRef = findInputRef(backgroundState);
    const forwardedBeforeBackground = controlledPort.forwardedMutationCount();
    const backgroundAct = await execute(OWNER_AGENT_ID, 'background-act', {
      operation: 'act',
      stateId: backgroundState.stateId,
      mutation: {
        kind: 'set_value',
        elementRef: backgroundInputRef,
        value: BACKGROUND_BUSINESS_VALUE,
        deliveryMode: 'background',
      },
      expect: { kind: 'text_present', text: BACKGROUND_BUSINESS_VALUE },
    });
    const backgroundResponse = parseHandlerResponse(backgroundAct, 'background act');
    assert(backgroundResponse.operation === 'act' && backgroundResponse.result, 'Background act returned no action result');
    assert(backgroundResponse.result.delivery === 'confirmed', `Background delivery was ${backgroundResponse.result.delivery}`);
    assert(backgroundResponse.result.verification === 'satisfied', `Background verification was ${backgroundResponse.result.verification}`);
    assert(backgroundResponse.result.overall === 'succeeded', `Background overall was ${backgroundResponse.result.overall}`);
    assert(
      controlledPort.forwardedMutationCount() === forwardedBeforeBackground + 1,
      'Background mutation did not reach the real provider exactly once',
    );
    const backgroundProviderCall = controlledPort.calls.findLast((call) => (
      call.toolName === 'set_value'
      && call.surfaceSessionId === computerSessionId
      && call.deliveryMode === 'background'
    ));
    assert(
      backgroundProviderCall?.forwarded && backgroundProviderCall.providerSucceeded,
      'Background business mutation did not succeed through the real helper provider',
    );
    const backgroundReadbackPassed = await waitFor(
      () => readFixtureState(fixture?.statePath || '') === `value=${BACKGROUND_BUSINESS_VALUE}`,
      5_000,
      100,
    );
    assert(
      backgroundReadbackPassed,
      `Background fixture readback failed: ${readFixtureState(fixture.statePath)}`,
    );
    const backgroundSuccessorValue = backgroundResponse.result.successorState?.elements.find((element) => (
      element.label === TARGET_FIELD_LABEL
    ))?.value;
    assert(
      backgroundSuccessorValue === BACKGROUND_BUSINESS_VALUE,
      `Background successor state read back ${backgroundSuccessorValue || 'missing'}`,
    );
    const backgroundImage = dataUrlFromResult(backgroundAct);
    assert(backgroundImage, 'Background action did not return a successor screenshot');
    const backgroundScreenshot = saveDataUrl(backgroundImage, join(outputDir, 'background.png'));
    const afterBackgroundOrder = await windowOrderEvidence({
      port: controlledPort,
      target: root,
      sentinel: backgroundSentinelRoot,
      surfaceSessionId: computerSessionId,
      callId: 'computer-background-order-after',
    });
    const backgroundFrontmostAfter = systemFrontmostEvidence(backgroundSentinelRoot.pid);
    assert(
      backgroundFrontmostAfter.expectedActive,
      `Background delivery stole foreground: ${JSON.stringify(backgroundFrontmostAfter)}`,
    );
    const backgroundBusinessReadback = {
      expected: `value=${BACKGROUND_BUSINESS_VALUE}`,
      actual: readFixtureState(fixture.statePath),
      sha256: sha256(readFixtureState(fixture.statePath) || ''),
    };
    evidence.backgroundActivation = backgroundActivation;
    assertions.backgroundFallbackVerified = backgroundProviderCall.deliveryMode === 'background'
      && backgroundResponse.result.delivery === 'confirmed'
      && backgroundResponse.result.verification === 'satisfied'
      && backgroundBusinessReadback.actual === backgroundBusinessReadback.expected
      && backgroundFrontmostBefore.expectedActive
      && backgroundFrontmostAfter.expectedActive;
    evidence.foregroundBackground = {
      screenshot: backgroundScreenshot,
      businessReadback: backgroundBusinessReadback,
      foreground: { frontmost: foregroundFrontmost, zOrderDiagnostic: foregroundOrder },
      backgroundBefore: { frontmost: backgroundFrontmostBefore, zOrderDiagnostic: beforeBackgroundOrder },
      backgroundAfter: { frontmost: backgroundFrontmostAfter, zOrderDiagnostic: afterBackgroundOrder },
      helperCall: backgroundProviderCall,
      successorValueSha256: sha256(backgroundSuccessorValue),
    };
    withoutCanary(backgroundAct, 'Background Stateful Computer result');

    proof.stage = 'takeover';
    const takeoverObservation = await observe('takeover-observe');
    const takeoverState = stateFromObserve(takeoverObservation, 'takeover observe');
    const takeoverInputRef = findInputRef(takeoverState);
    const forwardedBeforeTakeover = controlledPort.forwardedMutationCount();
    const takeoverGate = controlledPort.armMutationGate('takeover');
    const takeoverMutation = execute(OWNER_AGENT_ID, 'takeover-gated-act', {
      operation: 'act',
      stateId: takeoverState.stateId,
      mutation: { kind: 'set_value', elementRef: takeoverInputRef, value: TAKEOVER_BLOCKED_VALUE },
      expect: { kind: 'element_value_equals', elementRef: takeoverInputRef, value: TAKEOVER_BLOCKED_VALUE },
    });
    await withTimeout(takeoverGate.entered, CONTROL_GATE_MS, 'Takeover mutation gate');
    const takeoverControl = await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: computerSessionId,
      action: 'takeover',
      reason: 'Stateful Computer acceptance takeover',
    });
    assert(takeoverControl.requestId, 'Computer takeover did not return a request id');
    const takeoverResult = await withTimeout(takeoverMutation, CONTROL_GATE_MS, 'Takeover-cancelled mutation');
    assert(!takeoverResult.ok, 'Takeover-cancelled mutation unexpectedly succeeded');
    assert(controlledPort.forwardedMutationCount() === forwardedBeforeTakeover, 'Takeover-cancelled mutation reached the provider');
    assert(readFixtureState(fixture.statePath) === `value=${BACKGROUND_BUSINESS_VALUE}`, 'Takeover-cancelled mutation changed fixture state');
    const blockedDuringTakeover = await execute(OWNER_AGENT_ID, 'takeover-blocked-act', {
      operation: 'act',
      stateId: takeoverState.stateId,
      mutation: { kind: 'set_value', elementRef: takeoverInputRef, value: TAKEOVER_BLOCKED_VALUE },
    });
    assert(!blockedDuringTakeover.ok, 'Mutation ran while human takeover was active');
    await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: computerSessionId,
      action: 'resume',
    });
    const staleAfterResume = await execute(OWNER_AGENT_ID, 'takeover-stale-after-resume', {
      operation: 'act',
      stateId: takeoverState.stateId,
      mutation: { kind: 'set_value', elementRef: takeoverInputRef, value: TAKEOVER_BLOCKED_VALUE },
    });
    assert(!staleAfterResume.ok, 'Pre-takeover state was accepted after resume');
    assert(controlledPort.forwardedMutationCount() === forwardedBeforeTakeover, 'A takeover stale-state attempt reached the provider');
    assertions.takeoverInterruptedActiveOperation = true;
    assertions.takeoverNoPostMutation = true;
    assertions.takeoverBlockedMutation = true;
    assertions.takeoverResume = true;
    assertions.takeoverInvalidatedState = true;

    proof.stage = 'stop';
    const stopObservation = await observe('stop-observe');
    const stopState = stateFromObserve(stopObservation, 'stop observe');
    const stopInputRef = findInputRef(stopState);
    const stopBinding = runtime.getComputerBinding({
      identity,
      providerStateId: stopState.stateId,
    });
    assert(stopBinding, 'Stop observation lost its Computer Surface binding');
    const forwardedBeforeStop = controlledPort.forwardedMutationCount();
    const stopGate = controlledPort.armMutationGate('stop');
    const stopMutation = execute(OWNER_AGENT_ID, 'stop-gated-act', {
      operation: 'act',
      stateId: stopState.stateId,
      mutation: { kind: 'set_value', elementRef: stopInputRef, value: STOP_BLOCKED_VALUE },
      expect: { kind: 'element_value_equals', elementRef: stopInputRef, value: STOP_BLOCKED_VALUE },
    });
    await withTimeout(stopGate.entered, CONTROL_GATE_MS, 'Stop mutation gate');
    const stopStartedAt = Date.now();
    await runtime.controlConversation({
      conversationId: CONVERSATION_ID,
      surfaceSessionId: computerSessionId,
      action: 'stop',
      reason: 'Stateful Computer acceptance stop',
    });
    const stopLatencyMs = Date.now() - stopStartedAt;
    const stopResult = await withTimeout(stopMutation, CONTROL_GATE_MS, 'Stopped Computer mutation');
    assert(!stopResult.ok, 'Stopped Computer mutation unexpectedly succeeded');
    assert(stopLatencyMs < CONTROL_GATE_MS, `Computer stop latency ${stopLatencyMs}ms exceeded ${CONTROL_GATE_MS}ms`);
    assert(controlledPort.forwardedMutationCount() === forwardedBeforeStop, 'Stopped mutation reached the provider');
    assert(readFixtureState(fixture.statePath) === `value=${BACKGROUND_BUSINESS_VALUE}`, 'Stopped mutation changed fixture state');
    const postStop = await execute(OWNER_AGENT_ID, 'post-stop-act', {
      operation: 'act',
      stateId: stopState.stateId,
      mutation: { kind: 'set_value', elementRef: stopInputRef, value: STOP_BLOCKED_VALUE },
    });
    assert(!postStop.ok, 'A new mutation was accepted after stop');
    assert(controlledPort.forwardedMutationCount() === forwardedBeforeStop, 'Post-stop mutation reached the provider');
    assertions.stopInterruptedActiveOperation = true;
    assertions.stopLatencyBelowTwoSeconds = true;
    assertions.stopNoPostMutation = true;
    evidence.stopLatencyMs = stopLatencyMs;

    proof.stage = 'cleanup';
    await runtime.endRun(identity);
    runEnded = true;
    const finalSnapshot = runtime.snapshotConversation(CONVERSATION_ID);
    const finalSession = finalSnapshot.sessions.find((candidate) => (
      candidate.session.sessionId === computerSessionId
    ));
    assert(finalSession?.session.state === 'completed', `Computer Surface cleanup state was ${finalSession?.session.state || 'missing'}`);
    assert(runtime.interrupts.activeOperationCount(stopBinding.subject) === 0, 'Computer Surface retained an active operation after cleanup');
    assert(!existsSync(lockPath), 'Computer-use lock remained after endRun cleanup');
    const endSessionCalls = controlledPort.calls.filter((call) => (
      call.toolName === 'end_session'
      && call.surfaceSessionId === computerSessionId
      && call.forwarded
      && call.providerSucceeded
    ));
    assert(endSessionCalls.length === 1, 'cua-driver end_session did not succeed exactly once');
    const releasedInputLock = inputLockLifecycle.some((event) => (
      event.scope === computerSessionId
      && event.phase === 'release'
      && event.status === 'succeeded'
      && (event.outcome === 'released' || event.outcome === 'already_released')
    ));
    assert(releasedInputLock, 'Computer input lock release was not observed after endRun cleanup');
    assertions.endSessionForwarded = true;
    assertions.activeOperationsReleased = true;
    assertions.cuaLockReleased = true;
    assertions.surfaceSessionCompleted = true;
    assertions.cleanupReleasedComputerLock = acquiredInputLock
      && releasedInputLock
      && endSessionCalls.length === 1
      && !existsSync(lockPath);
    assertions.inputLockRecovered = acquiredInputLock
      && blockedInputLock
      && releasedInputLock
      && !existsSync(lockPath);
    evidence.computerCleanup = {
      lockRemoved: !existsSync(lockPath),
      releasedInputLock,
      activeOperationCount: runtime.interrupts.activeOperationCount(stopBinding.subject),
      endSessionCall: endSessionCalls[0],
      finalSessionState: finalSession.session.state,
      lifecycle: inputLockLifecycle,
    };

    proof.stage = 'redaction';
    const snapshot = runtime.snapshotConversation(CONVERSATION_ID);
    withoutCanary(events, 'Computer Surface event stream');
    withoutCanary(snapshot, 'Computer Surface conversation snapshot');
    withoutCanary(permissionRequests, 'Computer permission projection');
    withoutCanary(controlledPort.calls, 'Computer driver call evidence');
    assertions.redactionCanaryAbsentFromToolResult = true;
    assertions.redactionCanaryAbsentFromEvents = true;
    assertions.redactionCanaryAbsentFromSnapshot = true;
    assertions.redactionCanaryAbsentFromSavedEvidence = true;
    evidence.canary = {
      injected: true,
      sha256: sha256(CANARY),
      rawPersisted: false,
      scanned: ['tool-result', 'surface-events', 'conversation-snapshot', 'permission-projection', 'driver-call-evidence', 'proof'],
    };
    evidence.permissionRequestCount = permissionRequests.length;
    evidence.driverCalls = controlledPort.calls;
    evidence.surfaceEventCount = events.length;
    evidence.finalSession = finalSession;
    status = 'passed';
    proof.status = status;
    proof.stage = 'complete';
  } catch (error) {
    if (!(error instanceof AcceptanceBlockedError)) {
      failure = errorMessage(error);
      proof.failure = {
        code: 'COMPUTER_ACCEPTANCE_FAILED',
        message: failure,
        userActionRequired: false,
      };
      proof.status = 'failed';
      status = 'failed';
    }
  } finally {
    controlledPort.releaseGate();
    if (runStarted && !runEnded) {
      try {
        await runtime.endRun(identity);
        runEnded = true;
        assertions.failClosedEndRun = true;
      } catch (cleanupError) {
        assertions.failClosedEndRun = false;
        evidence.endRunCleanupError = errorMessage(cleanupError);
      }
    }
    try {
      await stopTargetFixture(fixture);
      assertions.fixtureTerminated = fixture ? fixture.process.exitCode !== null || fixture.process.killed : true;
    } catch (fixtureError) {
      assertions.fixtureTerminated = false;
      evidence.fixtureCleanupError = errorMessage(fixtureError);
    }
    try {
      for (const sentinel of foregroundSentinels) await stopTargetFixture(sentinel);
      assertions.foregroundSentinelsTerminated = foregroundSentinels.every((sentinel) => (
        sentinel.process.exitCode !== null || sentinel.process.killed
      ));
    } catch (sentinelError) {
      assertions.foregroundSentinelsTerminated = false;
      evidence.foregroundSentinelCleanupError = errorMessage(sentinelError);
    }
    if (fixture?.stderr()) evidence.fixtureStderr = fixture.stderr();
    const sentinelStderr = foregroundSentinels.map((sentinel) => sentinel.stderr()).filter(Boolean);
    if (sentinelStderr.length > 0) evidence.foregroundSentinelStderr = sentinelStderr;
    if (serverAdded) {
      try {
        await client.disconnect(CUA_DRIVER_SERVER_NAME);
        assertions.mcpDisconnected = true;
      } catch (disconnectError) {
        assertions.mcpDisconnected = false;
        evidence.mcpDisconnectError = errorMessage(disconnectError);
      }
      await client.removeServer(CUA_DRIVER_SERVER_NAME).catch(() => undefined);
    }
    unsubscribeInputLockLifecycle();
    registry.clear();
    rmSync(tmpRoot, { recursive: true, force: true });
    evidence.driverCalls = controlledPort.calls;
    evidence.inputLockLifecycle = inputLockLifecycle;
    evidence.surfaceEventCount = events.length;
    proof.exitCode = status === 'passed' ? 0 : status === 'blocked' ? 2 : 1;
    proof.recordedAt = new Date().toISOString();
    withoutCanary(proof, 'Computer acceptance proof');
    writeJson(join(outputDir, 'proof.json'), proof);
  }

  const result = {
    ok: status === 'passed',
    status,
    stage: proof.stage,
    outputDir,
    proofPath: join(outputDir, 'proof.json'),
    failure,
    assertions,
  };
  if (hasFlag(args, 'json')) printJson(result);
  else printKeyValue('Surface Execution Computer Acceptance', [
    ['ok', result.ok],
    ['status', status],
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
