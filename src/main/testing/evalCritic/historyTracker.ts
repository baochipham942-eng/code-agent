// ============================================================================
// P4 Eval Critic — History Tracker
// Version tracking with regression detection and lineage visualization
// ============================================================================

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import type { EvalHistory, EvalHistoryEntry } from '../types';

const HISTORY_FILE = 'eval-history.json';

export class EvalHistoryTracker {
  private readonly historyPath: string;

  constructor(private readonly resultsDir: string) {
    this.historyPath = join(resultsDir, HISTORY_FILE);
  }

  /** Load history from disk (returns empty history if file doesn't exist) */
  async load(): Promise<EvalHistory> {
    try {
      const raw = await readFile(this.historyPath, 'utf-8');
      return JSON.parse(raw) as EvalHistory;
    } catch {
      return { currentBest: '', entries: [] };
    }
  }

  /** Append a new entry and update currentBest if this is the best run */
  async append(entry: EvalHistoryEntry): Promise<void> {
    const history = await this.load();

    history.entries.push(entry);

    // Update currentBest: compare composite score (passRate * qualityScore)
    const composite = entry.metrics.passRate * entry.metrics.qualityScore;
    const bestEntry = history.entries.find((e) => e.version === history.currentBest);
    const bestComposite = bestEntry
      ? bestEntry.metrics.passRate * bestEntry.metrics.qualityScore
      : -1;

    if (composite > bestComposite) {
      history.currentBest = entry.version;
    }

    await this.save(history);
  }

  /**
   * Detect regression by comparing current entry against the most recent prior entry.
   * Regression criteria:
   *  - passRate drops > 10%  (absolute percentage points)
   *  - qualityScore drops > 15%  (absolute percentage points)
   */
  async detectRegression(current: EvalHistoryEntry): Promise<{
    isRegression: boolean;
    details: string[];
  }> {
    const history = await this.load();
    const details: string[] = [];

    // Find the previous entry (the one right before current, by timestamp)
    const previousEntries = history.entries
      .filter((e) => e.version !== current.version && e.timestamp < current.timestamp)
      .sort((a, b) => b.timestamp - a.timestamp);

    const previous = previousEntries[0];
    if (!previous) {
      return { isRegression: false, details: ['No previous entry — nothing to compare'] };
    }

    const passRateDelta = current.metrics.passRate - previous.metrics.passRate;
    const qualityDelta = current.metrics.qualityScore - previous.metrics.qualityScore;

    if (passRateDelta < -0.10) {
      details.push(
        `passRate dropped ${(Math.abs(passRateDelta) * 100).toFixed(1)}% ` +
        `(${(previous.metrics.passRate * 100).toFixed(1)}% → ${(current.metrics.passRate * 100).toFixed(1)}%)`,
      );
    }

    if (qualityDelta < -0.15) {
      details.push(
        `qualityScore dropped ${(Math.abs(qualityDelta) * 100).toFixed(1)}% ` +
        `(${(previous.metrics.qualityScore * 100).toFixed(1)}% → ${(current.metrics.qualityScore * 100).toFixed(1)}%)`,
      );
    }

    return {
      isRegression: details.length > 0,
      details: details.length > 0 ? details : ['No regression detected'],
    };
  }

  /**
   * Generate a human-readable lineage string.
   * Example: "v1 → v2 → v3 (current_best)"
   */
  generateLineage(): string {
    // We need sync access, but lineage is always called after load().
    // Since we can't make this async without changing the interface,
    // we read synchronously using the last known state.
    // For correctness in an async world, callers should ensure load() was called.
    try {
      const raw = require('node:fs').readFileSync(this.historyPath, 'utf-8');
      const history = JSON.parse(raw) as EvalHistory;
      return this.buildLineageString(history);
    } catch {
      return '(no history)';
    }
  }

  private buildLineageString(history: EvalHistory): string {
    if (history.entries.length === 0) return '(no history)';

    const sorted = [...history.entries].sort((a, b) => a.timestamp - b.timestamp);
    const parts = sorted.map((e) => {
      const label = e.version;
      return label === history.currentBest ? `${label} (current_best)` : label;
    });

    return parts.join(' → ');
  }

  private async save(history: EvalHistory): Promise<void> {
    await mkdir(dirname(this.historyPath), { recursive: true });
    await writeFile(this.historyPath, JSON.stringify(history, null, 2), 'utf-8');
  }
}
