// ============================================================================
// TUI Input Manager — Raw mode key handling with history
// ============================================================================

import type { TUIScreen } from './screen';

export type InputSubmitHandler = (text: string) => void;
export type InputCancelHandler = () => void;

/**
 * Raw-mode input manager for the TUI.
 * Handles character-by-character input, cursor movement, history, paste.
 */
export class InputManager {
  private screen: TUIScreen;
  private buffer = '';
  private cursor = 0;
  private history: string[] = [];
  private historyIndex = -1;
  private tempBuffer = ''; // saves current input when browsing history
  private onSubmit: InputSubmitHandler | null = null;
  private onCancel: InputCancelHandler | null = null;
  private active = false;

  constructor(screen: TUIScreen) {
    this.screen = screen;
  }

  /** Start listening for input */
  start(onSubmit: InputSubmitHandler, onCancel: InputCancelHandler): void {
    this.onSubmit = onSubmit;
    this.onCancel = onCancel;
    this.active = true;
    this.buffer = '';
    this.cursor = 0;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();
    process.stdin.on('data', this.handleData);
    this.screen.setInput('', 0);
  }

  /** Stop listening */
  stop(): void {
    this.active = false;
    process.stdin.removeListener('data', this.handleData);
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
  }

  /** Temporarily pause input (during agent run) */
  pause(): void {
    // Keep raw mode for ESC detection, but don't process regular input
    this.active = false;
  }

  /** Resume input after agent run */
  resume(): void {
    this.active = true;
    this.buffer = '';
    this.cursor = 0;
    this.screen.setInput('', 0);
  }

  private handleData = (data: Buffer): void => {
    const str = data.toString('utf-8');

    // ESC key — cancel running agent (works even when paused)
    if (str === '\x1b' && !this.active) {
      this.onCancel?.();
      return;
    }

    // Ctrl+C — exit
    if (str === '\x03') {
      this.onCancel?.();
      return;
    }

    if (!this.active) return;

    // Handle multi-byte sequences (paste, arrow keys, etc.)
    if (str.length > 1 && !str.startsWith('\x1b')) {
      // Paste: insert all characters at cursor
      this.insertText(str);
      return;
    }

    // Single character or escape sequence
    if (str === '\r' || str === '\n') {
      // Enter — submit
      const text = this.buffer.trim();
      if (text) {
        this.history.push(text);
        if (this.history.length > 100) this.history.shift();
      }
      this.historyIndex = -1;
      this.buffer = '';
      this.cursor = 0;
      this.screen.clearInput();
      if (text) {
        this.onSubmit?.(text);
      }
    } else if (str === '\x7f' || str === '\b') {
      // Backspace
      if (this.cursor > 0) {
        this.buffer = this.buffer.slice(0, this.cursor - 1) + this.buffer.slice(this.cursor);
        this.cursor--;
        this.screen.setInput(this.buffer, this.cursor);
      }
    } else if (str === '\x1b[D') {
      // Left arrow
      if (this.cursor > 0) {
        this.cursor--;
        this.screen.setInput(this.buffer, this.cursor);
      }
    } else if (str === '\x1b[C') {
      // Right arrow
      if (this.cursor < this.buffer.length) {
        this.cursor++;
        this.screen.setInput(this.buffer, this.cursor);
      }
    } else if (str === '\x1b[A') {
      // Up arrow — history previous
      this.navigateHistory(-1);
    } else if (str === '\x1b[B') {
      // Down arrow — history next
      this.navigateHistory(1);
    } else if (str === '\x1b[H' || str === '\x01') {
      // Home or Ctrl+A
      this.cursor = 0;
      this.screen.setInput(this.buffer, this.cursor);
    } else if (str === '\x1b[F' || str === '\x05') {
      // End or Ctrl+E
      this.cursor = this.buffer.length;
      this.screen.setInput(this.buffer, this.cursor);
    } else if (str === '\x1b[3~') {
      // Delete key
      if (this.cursor < this.buffer.length) {
        this.buffer = this.buffer.slice(0, this.cursor) + this.buffer.slice(this.cursor + 1);
        this.screen.setInput(this.buffer, this.cursor);
      }
    } else if (str === '\x15') {
      // Ctrl+U — clear line
      this.buffer = '';
      this.cursor = 0;
      this.screen.setInput(this.buffer, this.cursor);
    } else if (str === '\x17') {
      // Ctrl+W — delete word backward
      const before = this.buffer.slice(0, this.cursor);
      const after = this.buffer.slice(this.cursor);
      const trimmed = before.replace(/\S+\s*$/, '');
      this.buffer = trimmed + after;
      this.cursor = trimmed.length;
      this.screen.setInput(this.buffer, this.cursor);
    } else if (str >= ' ' && str.length === 1) {
      // Regular printable character
      this.insertText(str);
    }
  };

  private insertText(text: string): void {
    // Filter out non-printable characters
    const clean = text.replace(/[\x00-\x1f]/g, '');
    if (!clean) return;
    this.buffer = this.buffer.slice(0, this.cursor) + clean + this.buffer.slice(this.cursor);
    this.cursor += clean.length;
    this.screen.setInput(this.buffer, this.cursor);
  }

  private navigateHistory(direction: number): void {
    if (this.history.length === 0) return;

    if (this.historyIndex === -1) {
      this.tempBuffer = this.buffer;
    }

    const newIndex = this.historyIndex + direction;

    if (direction < 0) {
      // Going back in history
      const maxIndex = this.history.length - 1;
      if (this.historyIndex === -1) {
        this.historyIndex = maxIndex;
      } else if (newIndex >= 0) {
        this.historyIndex = newIndex;
      } else {
        return; // already at oldest
      }
      this.buffer = this.history[this.historyIndex];
    } else {
      // Going forward in history
      if (this.historyIndex === -1) return; // already at newest
      if (newIndex >= this.history.length) {
        this.historyIndex = -1;
        this.buffer = this.tempBuffer;
      } else {
        this.historyIndex = newIndex;
        this.buffer = this.history[this.historyIndex];
      }
    }

    this.cursor = this.buffer.length;
    this.screen.setInput(this.buffer, this.cursor);
  }
}
