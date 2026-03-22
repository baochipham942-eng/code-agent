// ============================================================================
// TUI Entry — Orchestrates screen, input, and agent integration
// ============================================================================

export { TUIScreen } from './screen';
export type { StatusBarData } from './screen';
export { InputManager } from './inputManager';

import { TUIScreen } from './screen';
import { InputManager } from './inputManager';

/**
 * Patch console.log and process.stdout.write to route through TUI scroll region.
 * This lets existing terminal.ts code work unchanged inside the TUI layout.
 */
export function patchStdout(screen: TUIScreen): () => void {
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  const origWrite = process.stdout.write.bind(process.stdout) as typeof process.stdout.write;

  // Give screen the raw write function so it can bypass the patch
  screen.setRawWrite((data: string) => { origWrite(data); });

  // Patch process.stdout.write — the core output path
  const patchedWrite = function (
    chunk: unknown,
    encodingOrCb?: BufferEncoding | ((err?: Error | null) => void),
    cb?: (err?: Error | null) => void,
  ): boolean {
    if (!screen.isActive) {
      return origWrite(chunk as string, encodingOrCb as BufferEncoding, cb as ((err?: Error | null) => void));
    }

    // Route through scroll region
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString() : String(chunk);
    screen.writeOutput(text);
    const callback = typeof encodingOrCb === 'function' ? encodingOrCb : cb;
    if (callback) callback();
    return true;
  } as typeof process.stdout.write;

  process.stdout.write = patchedWrite;

  // Patch console.log/warn — they call stdout.write internally but let's also patch directly
  console.log = (...args: unknown[]) => {
    if (!screen.isActive) return origLog(...args);
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    screen.writeLine(text);
  };

  console.warn = (...args: unknown[]) => {
    if (!screen.isActive) return origWarn(...args);
    const text = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    screen.writeLine(text);
  };

  // console.error left alone — goes to stderr (not affected by TUI)

  return () => {
    process.stdout.write = origWrite;
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  };
}

/**
 * Create a complete TUI instance.
 */
export function createTUI(): { screen: TUIScreen; input: InputManager; unpatch: () => void } {
  const screen = new TUIScreen();
  const input = new InputManager(screen);
  const unpatch = patchStdout(screen);
  return { screen, input, unpatch };
}
