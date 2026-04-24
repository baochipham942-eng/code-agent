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
const TARGET_APP = 'CodeAgentAXSmokeTarget';
const INPUT_TEXT = 'typed-by-background-ax';

interface AxElement {
  index: number;
  role: string;
  name: string;
  axPath: string;
}

function usage(): void {
  console.log(`Browser / Computer background Accessibility smoke

Usage:
  npm run acceptance:browser-computer-background-ax -- [options]

Options:
  --keep-target   Keep the temporary AX target app open after the smoke.
  --json          Print JSON only.
  --help          Show this help.

What it validates:
  - a temporary native macOS target app exposes bounded Accessibility elements
  - computer_use.get_ax_elements returns axPath locators
  - computer_use.type can set a target app text field through background_ax + axPath
  - computer_use.click can press a target app button through background_ax + axPath
  - state readback confirms the action changed the target app without foreground coordinates`);
}

function makeToolContext(): ToolContext {
  return {
    workingDirectory: process.cwd(),
    sessionId: 'browser-computer-background-ax-smoke',
    requestPermission: async () => true,
  };
}

async function runTool(
  params: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const result = await computerUseTool.execute(params, context);
  if (!result.success) {
    throw new Error(result.error || `computer_use ${String(params.action || 'unknown')} failed`);
  }
  return result;
}

function makeTargetSource(): string {
  return `#import <Cocoa/Cocoa.h>

@interface AppDelegate : NSObject <NSApplicationDelegate, NSTextFieldDelegate>
@property (nonatomic, copy) NSString *statePath;
@property (nonatomic, retain) NSTextField *inputField;
@property (nonatomic, retain) NSTextField *statusLabel;
@end

@implementation AppDelegate
- (instancetype)initWithStatePath:(NSString *)statePath {
  self = [super init];
  if (self) { self.statePath = statePath; }
  return self;
}
- (void)applicationDidFinishLaunching:(NSNotification *)notification {
  NSRect frame = NSMakeRect(0, 0, 360, 180);
  NSWindow *window = [[NSWindow alloc] initWithContentRect:frame styleMask:(NSWindowStyleMaskTitled | NSWindowStyleMaskClosable) backing:NSBackingStoreBuffered defer:NO];
  [window setTitle:@"Code Agent Background AX Smoke"];
  [window center];

  NSView *content = [[NSView alloc] initWithFrame:frame];
  [window setContentView:content];

  NSTextField *title = [NSTextField labelWithString:@"Code Agent AX Smoke Target"];
  [title setFrame:NSMakeRect(24, 132, 300, 24)];
  [content addSubview:title];

  self.inputField = [[NSTextField alloc] initWithFrame:NSMakeRect(24, 88, 220, 28)];
  [self.inputField setPlaceholderString:@"AX Smoke Input"];
  [self.inputField setAccessibilityLabel:@"Code Agent AX Smoke Input"];
  [self.inputField setDelegate:self];
  [content addSubview:self.inputField];

  NSButton *button = [[NSButton alloc] initWithFrame:NSMakeRect(24, 48, 140, 32)];
  [button setTitle:@"Run AX Smoke"];
  [button setButtonType:NSButtonTypeMomentaryPushIn];
  [button setBezelStyle:NSBezelStyleRounded];
  [button setTarget:self];
  [button setAction:@selector(buttonClicked:)];
  [button setAccessibilityLabel:@"Code Agent AX Smoke Button"];
  [content addSubview:button];

  self.statusLabel = [NSTextField labelWithString:@"Waiting"];
  [self.statusLabel setFrame:NSMakeRect(180, 54, 150, 22)];
  [self.statusLabel setAccessibilityLabel:@"Code Agent AX Smoke Status"];
  [content addSubview:self.statusLabel];

  [self writeState:@"ready"];
  [window makeKeyAndOrderFront:nil];
  [NSApp activateIgnoringOtherApps:YES];
}
- (void)buttonClicked:(id)sender {
  [self.statusLabel setStringValue:@"Clicked"];
  [self writeState:[NSString stringWithFormat:@"clicked;button=Run AX Smoke;input=%@", [self.inputField stringValue]]];
}
- (void)controlTextDidChange:(NSNotification *)notification {
  [self writeState:[NSString stringWithFormat:@"typing;input=%@", [self.inputField stringValue]]];
}
- (void)writeState:(NSString *)value {
  [value writeToFile:self.statePath atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    NSApplication *app = [NSApplication sharedApplication];
    [app setActivationPolicy:NSApplicationActivationPolicyRegular];
    NSString *statePath = argc > 1 ? [NSString stringWithUTF8String:argv[1]] : @"/tmp/code-agent-ax-smoke-state.txt";
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
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

function readState(statePath: string): string | null {
  if (!fs.existsSync(statePath)) return null;
  return fs.readFileSync(statePath, 'utf-8');
}

function getElements(result: ToolExecutionResult | null): AxElement[] {
  if (!result) return [];
  const elements = result.metadata?.elements;
  if (!Array.isArray(elements)) return [];
  return elements
    .map((element) => element as Partial<AxElement>)
    .filter((element): element is AxElement =>
      typeof element.index === 'number'
      && typeof element.role === 'string'
      && typeof element.name === 'string'
      && typeof element.axPath === 'string'
      && element.axPath.length > 0
    );
}

function getTrace(result: ToolExecutionResult): WorkbenchActionTrace | null {
  return (result.metadata?.workbenchTrace as WorkbenchActionTrace | undefined) || null;
}

function getTargetAxPath(result: ToolExecutionResult): string | null {
  const value = result.metadata?.targetAxPath;
  return typeof value === 'string' ? value : null;
}

async function createTargetApp(tmpRoot: string): Promise<string> {
  const sourcePath = path.join(tmpRoot, `${TARGET_APP}.m`);
  const targetPath = path.join(tmpRoot, TARGET_APP);
  fs.writeFileSync(sourcePath, makeTargetSource(), 'utf-8');
  await execFileAsync('clang', [sourcePath, '-o', targetPath, '-framework', 'Cocoa'], {
    timeout: 15_000,
    maxBuffer: 1024 * 1024,
  });
  return targetPath;
}

async function openTargetApp(targetPath: string, statePath: string): Promise<ChildProcessWithoutNullStreams> {
  const child = spawn(targetPath, [statePath], {
    cwd: path.dirname(targetPath),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const ready = await waitFor(() => readState(statePath) === 'ready', 7_000);
  if (!ready) {
    child.kill('SIGKILL');
    throw new Error(`Temporary AX target app did not become ready. state=${readState(statePath) || 'missing'}`);
  }

  const hasWindow = await waitForTargetWindow(TARGET_APP, 7_000);
  if (!hasWindow) {
    child.kill('SIGKILL');
    throw new Error('Temporary AX target app did not expose a window through System Events.');
  }

  return child;
}

async function waitForTargetWindow(targetApp: string, timeoutMs: number): Promise<boolean> {
  return waitFor(async () => {
    try {
      const { stdout } = await execFileAsync('osascript', [
        '-e',
        'on run argv',
        '-e',
        'set targetApp to item 1 of argv',
        '-e',
        'tell application "System Events"',
        '-e',
        'if not (exists application process targetApp) then return "missing"',
        '-e',
        'tell application process targetApp',
        '-e',
        'if exists window 1 then return "ready"',
        '-e',
        'return "missing"',
        '-e',
        'end tell',
        '-e',
        'end tell',
        '-e',
        'end run',
        targetApp,
      ], {
        timeout: 2_000,
        maxBuffer: 1024 * 1024,
      });
      return stdout.trim() === 'ready';
    } catch {
      return false;
    }
  }, timeoutMs, 150);
}

async function activateFinder(): Promise<void> {
  await execFileAsync('osascript', ['-e', 'tell application "Finder" to activate'], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

async function cleanupTarget(targetPath: string, child: ChildProcessWithoutNullStreams | null): Promise<void> {
  if (child && child.exitCode === null && !child.killed) {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  await execFileAsync('pkill', ['-f', targetPath], {
    timeout: 5_000,
    maxBuffer: 1024 * 1024,
  }).catch(() => undefined);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (hasFlag(args, 'help')) {
    usage();
    return;
  }

  if (process.platform !== 'darwin') {
    throw new Error('background_ax smoke requires macOS.');
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-background-ax-'));
  const statePath = path.join(tmpRoot, 'state.txt');
  const context = makeToolContext();
  const failures: string[] = [];
  let targetPath: string | null = null;
  let targetProcess: ChildProcessWithoutNullStreams | null = null;
  let frontmostBeforeAction: ComputerSurfaceSnapshot | null = null;
  let listResult: ToolExecutionResult | null = null;
  let typeResult: ToolExecutionResult | null = null;
  let clickResult: ToolExecutionResult | null = null;
  let inputElement: AxElement | null = null;
  let buttonElement: AxElement | null = null;
  let finalState: string | null = null;

  try {
    targetPath = await createTargetApp(tmpRoot);
    targetProcess = await openTargetApp(targetPath, statePath);
    await activateFinder();

    const observeResult = await runTool({
      action: 'observe',
      includeScreenshot: false,
    }, context);
    frontmostBeforeAction = (observeResult.metadata?.computerSurfaceSnapshot as ComputerSurfaceSnapshot | undefined) || null;

    listResult = await runTool({
      action: 'get_ax_elements',
      targetApp: TARGET_APP,
      limit: 20,
      maxDepth: 6,
      timeout: 5_000,
    }, context);

    const elements = getElements(listResult);
    inputElement = elements.find((element) => element.role === 'AXTextField') || null;
    buttonElement = elements.find((element) =>
      element.role === 'AXButton' && element.name.includes('Run AX Smoke')
    ) || null;

    if (!inputElement) {
      failures.push('AX listing did not include the target text field.');
    }
    if (!buttonElement) {
      failures.push('AX listing did not include the target button.');
    }
    if (frontmostBeforeAction?.appName === TARGET_APP) {
      failures.push('Temporary AX target was still frontmost before background actions.');
    }

    if (inputElement && buttonElement) {
      typeResult = await runTool({
        action: 'type',
        targetApp: TARGET_APP,
        axPath: inputElement.axPath,
        text: INPUT_TEXT,
        timeout: 5_000,
      }, context);

      clickResult = await runTool({
        action: 'click',
        targetApp: TARGET_APP,
        axPath: buttonElement.axPath,
        timeout: 5_000,
      }, context);

      await waitFor(() => (readState(statePath) || '').includes('clicked;'), 5_000);
      finalState = readState(statePath);

      const typeTrace = getTrace(typeResult);
      const clickTrace = getTrace(clickResult);
      if (typeResult.metadata?.computerSurfaceMode !== 'background_ax' || getTargetAxPath(typeResult) !== inputElement.axPath) {
        failures.push('Type action did not use background_ax with the input axPath.');
      }
      if (clickResult.metadata?.computerSurfaceMode !== 'background_ax' || getTargetAxPath(clickResult) !== buttonElement.axPath) {
        failures.push('Click action did not use background_ax with the button axPath.');
      }
      if (typeTrace?.mode !== 'background_ax' || typeTrace.success !== true) {
        failures.push('Type trace did not record a successful background_ax action.');
      }
      if (clickTrace?.mode !== 'background_ax' || clickTrace.success !== true) {
        failures.push('Click trace did not record a successful background_ax action.');
      }
      if (finalState !== `clicked;button=Run AX Smoke;input=${INPUT_TEXT}`) {
        failures.push(`Target state readback did not match expected typed/clicked state: ${finalState || 'missing'}`);
      }
    }

    const result = {
      ok: failures.length === 0,
      targetApp: TARGET_APP,
      frontmostBeforeAction,
      elements: getElements(listResult),
      inputElement,
      buttonElement,
      type: typeResult ? {
        success: typeResult.success,
        computerSurfaceMode: typeResult.metadata?.computerSurfaceMode ?? null,
        targetAxPath: getTargetAxPath(typeResult),
        traceId: getTrace(typeResult)?.id ?? null,
        traceMode: getTrace(typeResult)?.mode ?? null,
      } : null,
      click: clickResult ? {
        success: clickResult.success,
        computerSurfaceMode: clickResult.metadata?.computerSurfaceMode ?? null,
        targetAxPath: getTargetAxPath(clickResult),
        traceId: getTrace(clickResult)?.id ?? null,
        traceMode: getTrace(clickResult)?.mode ?? null,
      } : null,
      finalState,
      failures,
    };

    if (hasFlag(args, 'json')) {
      printJson(result);
    } else {
      printKeyValue('Browser / Computer Background AX Smoke Summary', [
        ['targetApp', TARGET_APP],
        ['frontmostBeforeAction', frontmostBeforeAction?.appName ?? null],
        ['elementCount', result.elements.length],
        ['inputAxPath', inputElement?.axPath ?? null],
        ['buttonAxPath', buttonElement?.axPath ?? null],
        ['typeMode', result.type?.computerSurfaceMode ?? null],
        ['clickMode', result.click?.computerSurfaceMode ?? null],
        ['finalState', finalState],
      ]);

      if (failures.length > 0) {
        console.log('\nFailures');
        for (const failure of failures) {
          console.log(`- ${failure}`);
        }
      } else {
        console.log('\nBackground AX smoke passed.');
      }
    }

    if (failures.length > 0) {
      process.exit(1);
    }
  } finally {
    if (targetPath && !hasFlag(args, 'keep-target')) {
      await cleanupTarget(targetPath, targetProcess);
    }
    if (!hasFlag(args, 'keep-target')) {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

main().catch(finishWithError);
