// ============================================================================
// TUI Screen Manager — ANSI scroll regions + fixed bottom bar
// ============================================================================
//
// Cursor management uses two save/restore pairs:
//   DEC (\x1b7 / \x1b8) — tracks output cursor position in scroll region
//   SCO (\x1b[s / \x1b[u) — temp save/restore for status bar & input rendering
// ============================================================================

import chalk from 'chalk';

const ESC = '\x1b';
const CSI = `${ESC}[`;

const ansi = {
  altScreenEnter: `${CSI}?1049h`,
  altScreenLeave: `${CSI}?1049l`,
  scrollRegion: (top: number, bottom: number) => `${CSI}${top};${bottom}r`,
  resetScrollRegion: `${CSI}r`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  clearLine: `${CSI}2K`,
  showCursor: `${CSI}?25h`,
  hideCursor: `${CSI}?25l`,
  clearScreen: `${CSI}2J`,
  // DEC save/restore — for output cursor position tracking
  saveDEC: `${ESC}7`,
  restoreDEC: `${ESC}8`,
  // SCO save/restore — for temporary cursor excursions (status bar, input line)
  saveSCO: `${CSI}s`,
  restoreSCO: `${CSI}u`,
};

export interface StatusBarData {
  model?: string;
  provider?: string;
  duration?: number;
  inputTokens?: number;
  outputTokens?: number;
  contextPercent?: number;
  turns?: number;
  toolCount?: number;
  gitBranch?: string;
  phase?: string; // 'thinking' | 'running' | 'idle'
}

/**
 * TUI Screen — manages alternate screen, scroll region, fixed status bar + input line.
 *
 * Layout:
 *   Row 1 .. (rows-2)  → scroll region (output, spinner, etc.)
 *   Row rows-1          → status bar (fixed)
 *   Row rows            → input line (fixed)
 */
export class TUIScreen {
  private rows = 0;
  private cols = 0;
  private active = false;
  private statusData: StatusBarData = {};
  private inputText = '';
  private inputCursor = 0;
  private inputPrefix = chalk.green('❯ ');
  private inputPrefixLen = 2;

  /** Raw write bypasses stdout patch — set via setRawWrite() */
  private rawWrite: (data: string) => void = (data) => process.stdout.write(data);

  setRawWrite(fn: (data: string) => void): void {
    this.rawWrite = fn;
  }

  /** Enter TUI mode */
  enter(): void {
    if (this.active) return;
    this.active = true;

    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;

    this.rawWrite(ansi.altScreenEnter);
    this.rawWrite(ansi.clearScreen);

    // Set scroll region (top area for output)
    this.rawWrite(ansi.scrollRegion(1, this.rows - 2));

    // Position cursor at top of scroll region and save as DEC (output position)
    this.rawWrite(ansi.moveTo(1, 1));
    this.rawWrite(ansi.saveDEC);

    // Render fixed areas (uses SCO save/restore, won't disturb DEC)
    this.renderStatusBar();
    this.renderInputLine();

    // Restore output cursor position
    this.rawWrite(ansi.restoreDEC);

    process.stdout.on('resize', this.onResize);
  }

  /** Leave TUI mode */
  leave(): void {
    if (!this.active) return;
    this.active = false;

    process.stdout.removeListener('resize', this.onResize);
    this.rawWrite(ansi.resetScrollRegion);
    this.rawWrite(ansi.showCursor);
    this.rawWrite(ansi.altScreenLeave);
  }

  get isActive(): boolean {
    return this.active;
  }

  // --------------------------------------------------------------------------
  // Output (scroll region)
  // --------------------------------------------------------------------------

  /**
   * Write content to the scroll region.
   * Restores DEC cursor → writes → saves DEC cursor.
   */
  writeOutput(text: string): void {
    if (!this.active) {
      this.rawWrite(text);
      return;
    }
    // Restore output cursor position in scroll region
    this.rawWrite(ansi.restoreDEC);
    this.rawWrite(text);
    // Save updated output cursor position
    this.rawWrite(ansi.saveDEC);
  }

  writeLine(text: string): void {
    this.writeOutput(text + '\n');
  }

  // --------------------------------------------------------------------------
  // Status Bar (fixed row: rows - 1)
  // --------------------------------------------------------------------------

  updateStatus(data: Partial<StatusBarData>): void {
    Object.assign(this.statusData, data);
    if (this.active) {
      this.renderStatusBar();
    }
  }

  private renderStatusBar(): void {
    const d = this.statusData;
    const segments: string[] = [];

    if (d.phase === 'thinking') {
      segments.push(chalk.cyan('♠ thinking'));
    } else if (d.phase === 'running') {
      segments.push(chalk.yellow('⚙ running'));
    }

    if (d.model) {
      const label = d.provider ? `${d.provider}/${d.model}` : d.model;
      segments.push(label);
    }

    if (d.duration != null && d.duration > 0) {
      const dur = d.duration < 1000
        ? `${d.duration}ms`
        : d.duration < 60000
          ? `${(d.duration / 1000).toFixed(1)}s`
          : `${Math.floor(d.duration / 60000)}m${Math.round((d.duration % 60000) / 1000)}s`;
      segments.push(dur);
    }

    const total = (d.inputTokens || 0) + (d.outputTokens || 0);
    if (total > 0) {
      segments.push(`${(total / 1000).toFixed(1)}k tokens`);
    }

    if (d.contextPercent != null && d.contextPercent > 0) {
      const bar = this.miniBar(d.contextPercent);
      const color = d.contextPercent > 80 ? chalk.red : d.contextPercent > 60 ? chalk.yellow : chalk.dim;
      segments.push(color(`ctx ${bar} ${d.contextPercent.toFixed(0)}%`));
    }

    if (d.turns) segments.push(`${d.turns} turns`);
    if (d.toolCount) segments.push(`${d.toolCount} tools`);
    if (d.gitBranch) segments.push(`git:(${d.gitBranch})`);

    const line = segments.length > 0
      ? `  ${segments.join('  ·  ')}`
      : '';

    // Use SCO save/restore (doesn't disturb DEC output position)
    this.rawWrite(ansi.saveSCO);
    this.rawWrite(ansi.moveTo(this.rows - 1, 1));
    this.rawWrite(ansi.clearLine);
    this.rawWrite(chalk.bgGray.white(line.padEnd(this.cols)));
    this.rawWrite(ansi.restoreSCO);
  }

  private miniBar(percent: number): string {
    const filled = Math.round(percent / 10);
    return '█'.repeat(filled) + '░'.repeat(10 - filled);
  }

  // --------------------------------------------------------------------------
  // Input Line (fixed row: rows)
  // --------------------------------------------------------------------------

  setInput(text: string, cursor?: number): void {
    this.inputText = text;
    this.inputCursor = cursor ?? text.length;
    if (this.active) {
      this.renderInputLine();
      this.focusInput();
    }
  }

  getInput(): string {
    return this.inputText;
  }

  clearInput(): void {
    this.setInput('', 0);
  }

  private renderInputLine(): void {
    // Use SCO save/restore
    this.rawWrite(ansi.saveSCO);
    this.rawWrite(ansi.moveTo(this.rows, 1));
    this.rawWrite(ansi.clearLine);

    const maxInputWidth = this.cols - this.inputPrefixLen - 1;
    let displayText = this.inputText;
    if (displayText.length > maxInputWidth) {
      const start = Math.max(0, this.inputCursor - maxInputWidth + 10);
      displayText = '…' + displayText.substring(start, start + maxInputWidth - 1);
    }

    this.rawWrite(this.inputPrefix + displayText);
    this.rawWrite(ansi.restoreSCO);
  }

  /** Move visible cursor to input line at current cursor position */
  focusInput(): void {
    const col = this.inputPrefixLen + this.inputCursor + 1;
    this.rawWrite(ansi.moveTo(this.rows, Math.min(col, this.cols)));
    this.rawWrite(ansi.showCursor);
  }

  // --------------------------------------------------------------------------
  // Resize
  // --------------------------------------------------------------------------

  private onResize = (): void => {
    this.rows = process.stdout.rows || 24;
    this.cols = process.stdout.columns || 80;
    this.rawWrite(ansi.scrollRegion(1, this.rows - 2));
    this.renderStatusBar();
    this.renderInputLine();
  };
}
