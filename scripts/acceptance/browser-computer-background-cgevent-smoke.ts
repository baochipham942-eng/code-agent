import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { promisify } from 'util';
import {
  finishWithError,
  hasFlag,
  parseArgs,
  printJson,
  printKeyValue,
} from './_helpers.ts';
import { computerUseTool } from '../../src/main/tools/vision/computerUse.ts';
import type { ToolContext, ToolExecutionResult } from '../../src/main/tools/types.ts';
import type { ComputerSurfaceSnapshot, WorkbenchActionTrace } from '../../src/shared/contract/desktop.ts';

const execFileAsync = promisify(execFile);
const TARGET_APP = 'CodeAgentCGEventSmokeTarget';

interface WindowCandidate {
  appName: string;
  bundleId?: string | null;
  pid: number;
  windowId: number;
  windowRef?: string | null;
  title?: string | null;
  bounds: { x: number; y: number; width: number; height: number };
  qualityScore?: number;
  qualityGrade?: string;
  recommended?: boolean;
}

interface MatrixScenarioResult {
  name: string;
  action: 'click' | 'rightClick' | 'doubleClick' | 'get_windows' | 'diagnose_app';
  expectation: 'delivered' | 'unavailable';
  windowTitle: string | null;
  windowId: number | null;
  windowRef: string | null;
  ok: boolean;
  state: string;
  error: string | null;
  failureCategory: string | null;
  metadata: {
    computerSurfaceMode?: unknown;
    targetWindowId?: unknown;
    targetWindowRef?: unknown;
    targetWindowCount?: unknown;
    recommendedWindow?: unknown;
    windowLocalPoint?: unknown;
    screenPoint?: unknown;
    usedWindowLocation?: unknown;
    isTargetActive?: unknown;
    eventNumbers?: unknown;
    targetVerification?: unknown;
    failureKind?: unknown;
    blockingReasons?: unknown;
    recommendedAction?: unknown;
    evidenceSummary?: unknown;
  } | null;
  failures: string[];
}

function usage(): void {
  console.log(`Browser / Computer background CGEvent smoke

Usage:
  npm run acceptance:browser-computer-background-cgevent -- [options]

Options:
  --keep-target   Keep the temporary CGEvent target app open after the smoke.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - a temporary native macOS target app exposes ordinary, secondary, and non-key visible windows
  - one target point is covered by a separate window and still receives a background CGEvent through windowRef/windowId
  - a minimized window is reported as unavailable/not recommended instead of being forced through a fake successful click
  - computer_use.diagnose_app reports target TCC/AX/CGEvent readiness and a recommended window
  - computer_use.get_windows returns scored candidates with pid + windowId + windowRef + bounds
  - computer_use.click/rightClick/doubleClick can post background CGEvents by pid/windowId/windowRef/windowLocalPoint
  - state readback confirms the target received events while it was not frontmost`);
}

function makeToolContext(): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId: 'browser-computer-background-cgevent-smoke',
    requestPermission: async () => true,
  };
}

async function runTool(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const result = await invokeTool(params, context);
  if (!result.success) {
    throw new Error(result.error || `computer_use ${String(params.action || 'unknown')} failed`);
  }
  return result;
}

async function invokeTool(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  return computerUseTool.execute(params, context);
}

function makeTargetSource(): string {
  return `#import <Cocoa/Cocoa.h>

@interface ClickView : NSView
@property (nonatomic, copy) NSString *statePath;
@property (nonatomic, copy) NSString *surfaceName;
@property (nonatomic) NSInteger eventCount;
@end

@implementation ClickView
- (BOOL)acceptsFirstResponder { return YES; }
- (void)recordEvent:(NSEvent *)event kind:(NSString *)kind {
  self.eventCount += 1;
  NSPoint local = [self convertPoint:[event locationInWindow] fromView:nil];
  NSString *state = [NSString stringWithFormat:@"event=%@;surface=%@;count=%ld;eventClickCount=%ld;x=%.1f;y=%.1f", kind, self.surfaceName ?: @"unknown", (long)self.eventCount, (long)[event clickCount], local.x, local.y];
  [state writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
  [self setNeedsDisplay:YES];
}
- (void)mouseDown:(NSEvent *)event {
  [self recordEvent:event kind:@"left"];
}
- (void)rightMouseDown:(NSEvent *)event {
  [self recordEvent:event kind:@"right"];
}
- (void)drawRect:(NSRect)dirtyRect {
  if ([self.surfaceName isEqualToString:@"secondary"]) {
    [[NSColor colorWithCalibratedRed:0.12 green:0.45 blue:0.86 alpha:1] setFill];
  } else if ([self.surfaceName isEqualToString:@"nonkey"]) {
    [[NSColor colorWithCalibratedRed:0.35 green:0.35 blue:0.35 alpha:1] setFill];
  } else if ([self.surfaceName isEqualToString:@"covered"]) {
    [[NSColor colorWithCalibratedRed:0.18 green:0.55 blue:0.28 alpha:1] setFill];
  } else if ([self.surfaceName isEqualToString:@"cover"]) {
    [[NSColor colorWithCalibratedRed:0.10 green:0.10 blue:0.10 alpha:1] setFill];
  } else if ([self.surfaceName isEqualToString:@"minimized"]) {
    [[NSColor colorWithCalibratedRed:0.50 green:0.25 blue:0.80 alpha:1] setFill];
  } else {
    [[NSColor colorWithCalibratedRed:0.85 green:0.15 blue:0.15 alpha:1] setFill];
  }
  NSRectFill(self.bounds);
  NSString *label = [NSString stringWithFormat:@"%@ events: %ld", self.surfaceName ?: @"main", (long)self.eventCount];
  NSDictionary *attrs = @{ NSForegroundColorAttributeName: NSColor.whiteColor, NSFontAttributeName: [NSFont boldSystemFontOfSize:28] };
  [label drawAtPoint:NSMakePoint(36, 92) withAttributes:attrs];
}
@end

@interface NonKeyWindow : NSWindow
@end

@implementation NonKeyWindow
- (BOOL)canBecomeKeyWindow { return NO; }
- (BOOL)canBecomeMainWindow { return NO; }
@end

@interface AppDelegate : NSObject <NSApplicationDelegate>
@property (nonatomic, copy) NSString *statePath;
@property (nonatomic, strong) NSMutableArray<NSWindow *> *windows;
@end

@implementation AppDelegate
- (instancetype)initWithStatePath:(NSString *)statePath {
  self = [super init];
  if (self) {
    self.statePath = statePath;
    self.windows = [NSMutableArray array];
  }
  return self;
}
- (NSWindow *)makeWindowWithTitle:(NSString *)title surface:(NSString *)surface origin:(NSPoint)origin nonKey:(BOOL)nonKey {
  NSRect frame = NSMakeRect(origin.x, origin.y, 360, 220);
  Class windowClass = nonKey ? [NonKeyWindow class] : [NSWindow class];
  NSWindow *window = [[windowClass alloc] initWithContentRect:frame styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable) backing:NSBackingStoreBuffered defer:NO];
  [window setTitle:title];
  ClickView *view = [[ClickView alloc] initWithFrame:frame];
  view.statePath = self.statePath;
  view.surfaceName = surface;
  [window setContentView:view];
  [window makeKeyAndOrderFront:nil];
  [self.windows addObject:window];
  return window;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSWindow *mainWindow = [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke" surface:@"main" origin:NSMakePoint(160, 380) nonKey:NO];
  [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke Secondary" surface:@"secondary" origin:NSMakePoint(560, 380) nonKey:NO];
  [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke Non-Key" surface:@"nonkey" origin:NSMakePoint(360, 120) nonKey:YES];
  [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke Covered" surface:@"covered" origin:NSMakePoint(760, 120) nonKey:NO];
  [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke Cover" surface:@"cover" origin:NSMakePoint(800, 150) nonKey:NO];
  NSWindow *minimizedWindow = [self makeWindowWithTitle:@"Code Agent Background CGEvent Smoke Minimized" surface:@"minimized" origin:NSMakePoint(40, 120) nonKey:NO];
  [minimizedWindow miniaturize:nil];
  [mainWindow makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
  [@"ready" writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    if (argc < 2) { return 2; }
    NSString *statePath = [NSString stringWithUTF8String:argv[1]];
    [NSApplication sharedApplication];
    AppDelegate *delegate = [[AppDelegate alloc] initWithStatePath:statePath];
    [NSApp setDelegate:delegate];
    [NSApp setActivationPolicy:NSApplicationActivationPolicyRegular];
    [NSApp run];
  }
  return 0;
}`;
}

async function buildTarget(tmpDir: string): Promise<string> {
  const sourcePath = path.join(tmpDir, `${TARGET_APP}.m`);
  const binaryPath = path.join(tmpDir, TARGET_APP);
  await fs.promises.writeFile(sourcePath, makeTargetSource(), 'utf8');
  await execFileAsync('clang', [
    sourcePath,
    '-o',
    binaryPath,
    '-framework',
    'Cocoa',
  ], {
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  return binaryPath;
}

async function waitFor(fn: () => boolean, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function readState(statePath: string): string {
  return fs.existsSync(statePath) ? fs.readFileSync(statePath, 'utf8') : '';
}

async function activateFinder(): Promise<void> {
  await execFileAsync('osascript', ['-e', 'tell application "Finder" to activate'], {
    timeout: 5_000,
    maxBuffer: 1024 * 128,
  });
}

function getWindows(result: ToolExecutionResult): WindowCandidate[] {
  const windows = result.metadata?.windows;
  return Array.isArray(windows) ? windows as WindowCandidate[] : [];
}

function getTrace(result: ToolExecutionResult | null): WorkbenchActionTrace | null {
  const trace = result?.metadata?.workbenchTrace;
  return trace && typeof trace === 'object' ? trace as WorkbenchActionTrace : null;
}

function findWindowByTitle(windows: WindowCandidate[], titlePart: string): WindowCandidate | null {
  return windows.find((item) => (item.title || '').includes(titlePart)) || null;
}

function findWindowByExactTitle(windows: WindowCandidate[], title: string): WindowCandidate | null {
  return windows.find((item) => item.title === title) || null;
}

function makeWindowPoint(window: WindowCandidate): { x: number; y: number } {
  return {
    x: Math.round(window.bounds.width / 2),
    y: Math.round(window.bounds.height / 2),
  };
}

function scenarioExpectation(action: MatrixScenarioResult['action'], surfaceName: string): string[] {
  const eventName = action === 'rightClick' ? 'right' : 'left';
  const expected = [`event=${eventName}`, `surface=${surfaceName}`];
  if (action === 'doubleClick') {
    expected.push('eventClickCount=2');
  }
  return expected;
}

function metadataRecord(result: ToolExecutionResult | null): Record<string, unknown> | null {
  const metadata = result?.metadata;
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? metadata
    : null;
}

function classifySmokeFailure(message: string, metadata: Record<string, unknown> | null = null): string {
  const blockingReasons = Array.isArray(metadata?.blockingReasons)
    ? metadata.blockingReasons.filter((item): item is string => typeof item === 'string').join(' ')
    : '';
  const text = [
    typeof metadata?.failureKind === 'string' ? metadata.failureKind : '',
    message,
    blockingReasons,
  ].join(' ').toLowerCase();
  if (/permission_denied|tcc|accessibility|screen recording|screenrecording|not authorized|not permitted|privacy/.test(text)) {
    return 'tcc_or_permission';
  }
  if (/target_window_not_found|target window verification failed|stale|not visible now|target window not found|window not found|windowref/.test(text)) {
    return 'stale_or_missing_window';
  }
  if (/coordinate_untrusted|coordinate|outside target bounds|window local point|screen point/.test(text)) {
    return 'coordinate_untrusted';
  }
  if (/timed out|state did not change|did not receive|did not accept|ignored cgevent/.test(text)) {
    return 'app_did_not_accept_cgevent';
  }
  if (/cgeventsetwindowlocation|windowlocation/.test(text)) {
    return 'cgevent_window_location_unavailable';
  }
  return 'unknown';
}

function formatCategorizedFailure(category: string, message: string): string {
  return `[${category}] ${message}`;
}

function matrixMetadata(result: ToolExecutionResult | null): MatrixScenarioResult['metadata'] {
  const metadata = metadataRecord(result);
  if (!metadata) return null;
  return {
    computerSurfaceMode: metadata.computerSurfaceMode,
    targetWindowId: metadata.targetWindowId,
    targetWindowRef: metadata.targetWindowRef,
    targetWindowCount: metadata.targetWindowCount,
    recommendedWindow: metadata.recommendedWindow,
    windowLocalPoint: metadata.windowLocalPoint,
    screenPoint: metadata.screenPoint,
    usedWindowLocation: metadata.usedWindowLocation,
    isTargetActive: metadata.isTargetActive,
    eventNumbers: metadata.eventNumbers,
    targetVerification: metadata.targetVerification,
    failureKind: metadata.failureKind,
    blockingReasons: metadata.blockingReasons,
    recommendedAction: metadata.recommendedAction,
    evidenceSummary: metadata.evidenceSummary,
  };
}

async function runMatrixScenario(args: {
  name: string;
  action: MatrixScenarioResult['action'];
  surfaceName: string;
  window: WindowCandidate | null;
  statePath: string;
  context: ToolContext;
}): Promise<{ result: MatrixScenarioResult; clickResult: ToolExecutionResult | null }> {
  const failures: string[] = [];
  if (!args.window) {
    return {
      clickResult: null,
      result: {
        name: args.name,
        action: args.action,
        windowTitle: null,
        windowId: null,
        windowRef: null,
        expectation: 'delivered',
        ok: false,
        state: '',
        error: null,
        failureCategory: 'stale_or_missing_window',
        metadata: null,
        failures: [formatCategorizedFailure('stale_or_missing_window', `window not found for scenario ${args.name}`)],
      },
    };
  }

  fs.writeFileSync(args.statePath, 'ready', 'utf8');
  await activateFinder();
  const point = makeWindowPoint(args.window);
  let clickResult: ToolExecutionResult | null = null;
  let error: string | null = null;
  let failureCategory: string | null = null;
  try {
    clickResult = await invokeTool({
      action: args.action,
      targetApp: args.window.appName,
      pid: args.window.pid,
      windowId: args.window.windowId,
      windowRef: args.window.windowRef || undefined,
      bundleId: args.window.bundleId || undefined,
      title: args.window.title || undefined,
      windowLocalPoint: point,
      timeout: 10_000,
    }, args.context);
  } catch (toolError) {
    error = toolError instanceof Error ? toolError.message : String(toolError);
    failureCategory = classifySmokeFailure(error);
    failures.push(formatCategorizedFailure(failureCategory, error));
  }

  const clickMetadata = metadataRecord(clickResult);
  if (clickResult && !clickResult.success) {
    error = clickResult.error || 'computer_use returned success=false';
    failureCategory = classifySmokeFailure(error, clickMetadata);
    failures.push(formatCategorizedFailure(failureCategory, error));
  }

  if (clickResult?.success) {
    try {
      await waitFor(() => readState(args.statePath) !== 'ready', 5_000);
    } catch (stateError) {
      const message = stateError instanceof Error ? stateError.message : String(stateError);
      failureCategory = classifySmokeFailure(`state did not change after CGEvent: ${message}`, clickMetadata);
      failures.push(formatCategorizedFailure(failureCategory, `state did not change after CGEvent: ${message}`));
    }
  }
  const state = readState(args.statePath);
  for (const expected of scenarioExpectation(args.action, args.surfaceName)) {
    if (!state.includes(expected)) {
      const category = classifySmokeFailure(`state did not receive expected marker ${expected}`, clickMetadata);
      failureCategory = failureCategory || category;
      failures.push(formatCategorizedFailure(category, `state missing ${expected}: ${state || 'missing'}`));
    }
  }
  if (clickResult?.metadata?.computerSurfaceMode !== 'background_cgevent') {
    failures.push('click action did not report background_cgevent mode');
  }
  if (clickResult?.metadata?.targetWindowId !== args.window.windowId) {
    const category = classifySmokeFailure('targetWindowId mismatch', clickMetadata);
    failureCategory = failureCategory || category;
    failures.push(formatCategorizedFailure(category, `targetWindowId mismatch: ${String(clickResult?.metadata?.targetWindowId)}`));
  }
  if (args.window.windowRef && clickResult?.metadata?.targetWindowRef !== args.window.windowRef) {
    const category = classifySmokeFailure('targetWindowRef mismatch', clickMetadata);
    failureCategory = failureCategory || category;
    failures.push(formatCategorizedFailure(category, `targetWindowRef mismatch: ${String(clickResult?.metadata?.targetWindowRef)}`));
  }
  const verification = clickResult?.metadata?.targetVerification as { ok?: boolean } | undefined;
  if (verification && verification.ok === false) {
    failureCategory = failureCategory || 'stale_or_missing_window';
    failures.push(formatCategorizedFailure('stale_or_missing_window', 'target verification reported stale window'));
  }
  const trace = getTrace(clickResult);
  if (trace?.mode !== 'background_cgevent' || trace.success !== true) {
    failures.push('click trace did not record a successful background_cgevent action');
  }

  return {
    clickResult,
    result: {
      name: args.name,
      action: args.action,
      expectation: 'delivered',
      windowTitle: args.window.title || null,
      windowId: args.window.windowId,
      windowRef: args.window.windowRef || null,
      ok: failures.length === 0,
      state,
      error,
      failureCategory,
      metadata: matrixMetadata(clickResult),
      failures,
    },
  };
}

async function runUnavailableWindowScenario(args: {
  name: string;
  action: 'get_windows' | 'diagnose_app';
  targetApp: string;
  title: string;
  context: ToolContext;
}): Promise<MatrixScenarioResult> {
  let result: ToolExecutionResult | null = null;
  let error: string | null = null;
  let failureCategory: string | null = null;
  const failures: string[] = [];
  try {
    result = await invokeTool({
      action: args.action,
      targetApp: args.targetApp,
      title: args.title,
      limit: 20,
      timeout: 10_000,
    }, args.context);
  } catch (toolError) {
    error = toolError instanceof Error ? toolError.message : String(toolError);
  }

  const metadata = metadataRecord(result);
  if (error || result?.success === false) {
    error = error || result?.error || 'computer_use returned success=false';
    failureCategory = classifySmokeFailure(error, metadata);
    if (failureCategory !== 'stale_or_missing_window') {
      failures.push(formatCategorizedFailure(failureCategory, error));
    }
  } else {
    const targetWindowCount = typeof metadata?.targetWindowCount === 'number'
      ? metadata.targetWindowCount
      : Array.isArray(metadata?.windows)
        ? metadata.windows.length
        : 0;
    const recommendedWindow = metadata?.recommendedWindow as WindowCandidate | null | undefined;
    const recommendedGrade = typeof recommendedWindow?.qualityGrade === 'string'
      ? recommendedWindow.qualityGrade
      : null;
    if (targetWindowCount > 0 && recommendedWindow && recommendedGrade !== 'low') {
      failureCategory = 'minimized_window_recommended';
      failures.push(formatCategorizedFailure(
        failureCategory,
        `expected minimized window to be unavailable or low quality, got targetWindowCount=${targetWindowCount} recommendedGrade=${recommendedGrade || 'unknown'}`,
      ));
    }
  }

  const metadataForMatrix = matrixMetadata(result);
  return {
    name: args.name,
    action: args.action,
    expectation: 'unavailable',
    windowTitle: args.title,
    windowId: null,
    windowRef: null,
    ok: failures.length === 0,
    state: result?.success
      ? `targetWindowCount=${String(metadataForMatrix?.targetWindowCount ?? 0)}; recommended=${metadataForMatrix?.recommendedWindow ? 'yes' : 'no'}`
      : 'unavailable',
    error,
    failureCategory,
    metadata: metadataForMatrix,
    failures,
  };
}

function formatMatrixSummary(matrix: MatrixScenarioResult[]): string {
  return matrix.map((item) => {
    if (item.ok) return `${item.name}:ok`;
    const category = item.failureCategory ? `[${item.failureCategory}]` : '';
    return `${item.name}:fail${category}${item.failures.length ? ` ${item.failures.join(' | ')}` : ''}`;
  }).join(', ');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }
  if (process.platform !== 'darwin') {
    throw new Error('background_cgevent smoke requires macOS.');
  }

  const json = hasFlag(args, 'json');
  const keepTarget = hasFlag(args, 'keep-target');
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'code-agent-cgevent-smoke-'));
  const statePath = path.join(tmpDir, 'state.txt');
  const context = makeToolContext();
  let target: ChildProcessWithoutNullStreams | null = null;
  const failures: string[] = [];
  let frontmostBeforeAction: ComputerSurfaceSnapshot | null = null;
  let listResult: ToolExecutionResult | null = null;
  let diagnoseResult: ToolExecutionResult | null = null;
  let clickResult: ToolExecutionResult | null = null;
  let selectedWindow: WindowCandidate | null = null;
  let matrix: MatrixScenarioResult[] = [];
  let finalState = '';

  try {
    const targetBinary = await buildTarget(tmpDir);
    target = spawn(targetBinary, [statePath], {
      stdio: 'pipe',
      detached: false,
    });
    target.on('error', (error) => {
      failures.push(`target process error: ${error.message}`);
    });

    await waitFor(() => readState(statePath) === 'ready', 10_000);
    await activateFinder();

    const observeResult = await runTool({
      action: 'observe',
      includeScreenshot: false,
    }, context);
    frontmostBeforeAction = (observeResult.metadata?.computerSurfaceSnapshot as ComputerSurfaceSnapshot | undefined) || null;
    if (frontmostBeforeAction?.appName === TARGET_APP) {
      failures.push('Temporary CGEvent target was still frontmost before the background click.');
    }

    diagnoseResult = await runTool({
      action: 'diagnose_app',
      targetApp: TARGET_APP,
      limit: 20,
      timeout: 10_000,
    }, context);
    if (diagnoseResult.metadata?.cgEventSuitable !== true) {
      failures.push('diagnose_app did not report CGEvent as suitable for the temporary target.');
    }
    if (!diagnoseResult.metadata?.recommendedWindow) {
      failures.push('diagnose_app did not return a recommended window.');
    }

    listResult = await runTool({
      action: 'get_windows',
      targetApp: TARGET_APP,
      limit: 20,
      timeout: 10_000,
    }, context);
    const windows = getWindows(listResult);
    selectedWindow = findWindowByExactTitle(windows, 'Code Agent Background CGEvent Smoke') || windows[0] || null;
    if (!selectedWindow) {
      failures.push('get_windows did not return the temporary CGEvent target window.');
    }
    if (!listResult.metadata?.recommendedWindow) {
      failures.push('get_windows did not return a recommended window.');
    }

    const scenarios = [
      { name: 'appkit-main-left', action: 'click' as const, surfaceName: 'main', window: findWindowByExactTitle(windows, 'Code Agent Background CGEvent Smoke') },
      { name: 'appkit-main-right', action: 'rightClick' as const, surfaceName: 'main', window: findWindowByExactTitle(windows, 'Code Agent Background CGEvent Smoke') },
      { name: 'appkit-main-double', action: 'doubleClick' as const, surfaceName: 'main', window: findWindowByExactTitle(windows, 'Code Agent Background CGEvent Smoke') },
      { name: 'appkit-secondary-window', action: 'click' as const, surfaceName: 'secondary', window: findWindowByTitle(windows, 'Secondary') },
      { name: 'appkit-non-key-window', action: 'click' as const, surfaceName: 'nonkey', window: findWindowByTitle(windows, 'Non-Key') },
      { name: 'appkit-covered-window', action: 'click' as const, surfaceName: 'covered', window: findWindowByExactTitle(windows, 'Code Agent Background CGEvent Smoke Covered') },
    ];

    for (const scenario of scenarios) {
      const scenarioRun = await runMatrixScenario({
        ...scenario,
        statePath,
        context,
      });
      matrix.push(scenarioRun.result);
      if (!clickResult && scenarioRun.clickResult) {
        clickResult = scenarioRun.clickResult;
      }
      if (!scenarioRun.result.ok) {
        failures.push(`${scenarioRun.result.name}: ${scenarioRun.result.failures.join('; ')}`);
      }
    }
    for (const scenario of [
      { name: 'appkit-minimized-get-windows', action: 'get_windows' as const },
      { name: 'appkit-minimized-diagnose', action: 'diagnose_app' as const },
    ]) {
      const scenarioRun = await runUnavailableWindowScenario({
        ...scenario,
        targetApp: TARGET_APP,
        title: 'Code Agent Background CGEvent Smoke Minimized',
        context,
      });
      matrix.push(scenarioRun);
      if (!scenarioRun.ok) {
        failures.push(`${scenarioRun.name}: ${scenarioRun.failures.join('; ')}`);
      }
    }
    finalState = readState(statePath);

    const result = {
      ok: failures.length === 0,
      targetApp: TARGET_APP,
      coverageNotes: {
        swiftuiWindow: 'skipped: this smoke target is a single clang-built AppKit binary; a real SwiftUI regression needs a separate Swift/AppKit host or app bundle, so it is left out of this low-cost EchoApp pass.',
      },
      frontmostBeforeAction,
      diagnose: diagnoseResult ? {
        success: diagnoseResult.success,
        cgEventSuitable: diagnoseResult.metadata?.cgEventSuitable ?? null,
        axSuitable: diagnoseResult.metadata?.axSuitable ?? null,
        tcc: diagnoseResult.metadata?.tcc ?? null,
        recommendedWindow: diagnoseResult.metadata?.recommendedWindow ?? null,
      } : null,
      selectedWindow,
      click: clickResult ? {
        success: clickResult.success,
        computerSurfaceMode: clickResult.metadata?.computerSurfaceMode ?? null,
        targetWindowId: clickResult.metadata?.targetWindowId ?? null,
        targetPid: clickResult.metadata?.targetPid ?? null,
        targetWindowRef: clickResult.metadata?.targetWindowRef ?? null,
        windowLocalPoint: clickResult.metadata?.windowLocalPoint ?? null,
        screenPoint: clickResult.metadata?.screenPoint ?? null,
        usedWindowLocation: clickResult.metadata?.usedWindowLocation ?? null,
        isTargetActive: clickResult.metadata?.isTargetActive ?? null,
        eventNumbers: clickResult.metadata?.eventNumbers ?? null,
        targetVerification: clickResult.metadata?.targetVerification ?? null,
        trace: getTrace(clickResult),
      } : null,
      matrix,
      finalState,
      failures,
    };

    if (json) {
      printJson(result);
    } else {
      printKeyValue('Background CGEvent smoke', [
        ['ok', result.ok],
        ['frontmostBeforeAction', frontmostBeforeAction?.appName || null],
        ['diagnoseCgEventSuitable', result.diagnose?.cgEventSuitable ?? null],
        ['targetWindowId', selectedWindow?.windowId || null],
        ['targetPid', selectedWindow?.pid || null],
        ['targetWindowRef', selectedWindow?.windowRef || null],
        ['matrix', formatMatrixSummary(matrix)],
        ['swiftuiWindow', result.coverageNotes.swiftuiWindow],
        ['finalState', finalState || null],
        ['failures', failures.length ? failures.join('; ') : 'none'],
      ]);
    }

    if (failures.length > 0) {
      process.exitCode = 1;
    }
  } finally {
    if (target && !keepTarget) {
      target.kill('SIGTERM');
    }
  }
}

main().catch(finishWithError);
