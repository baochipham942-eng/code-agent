// ============================================================================
// Trend Tracker — Tracks eval results over time
// ============================================================================

import { promises as fs } from 'fs';
import path from 'path';
import type { TrendDataPoint } from '../types';

const MAX_ENTRIES = 100;

export class TrendTracker {
  private trendPath: string;

  constructor(private workingDir: string) {
    this.trendPath = path.join(workingDir, '.code-agent', 'eval-trend.json');
  }

  async append(dataPoint: TrendDataPoint): Promise<void> {
    const existing = await this.loadAll();
    existing.push(dataPoint);

    // Keep only the last MAX_ENTRIES
    const trimmed = existing.slice(-MAX_ENTRIES);

    const dir = path.dirname(this.trendPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(this.trendPath, JSON.stringify(trimmed, null, 2), 'utf-8');
  }

  async getRecent(count: number): Promise<TrendDataPoint[]> {
    const all = await this.loadAll();
    return all.slice(-count);
  }

  generateAsciiChart(points: TrendDataPoint[]): string {
    if (points.length === 0) {
      return '  (no data)';
    }

    const BAR_MAX_WIDTH = 40;
    const lines: string[] = [];

    lines.push('Pass Rate Trend');
    lines.push('─'.repeat(60));

    for (const point of points) {
      const date = new Date(point.timestamp).toISOString().slice(0, 10);
      const sha = point.commitSha.slice(0, 7);
      const pct = (point.passRate * 100).toFixed(0);
      const barLen = Math.round(point.passRate * BAR_MAX_WIDTH);
      const bar = '█'.repeat(barLen) + '░'.repeat(BAR_MAX_WIDTH - barLen);
      const scopeTag = point.scope === 'full' ? 'F' : 'S';

      lines.push(`  ${date} ${sha} [${scopeTag}] ${bar} ${pct}%`);
    }

    lines.push('─'.repeat(60));
    lines.push(`  Showing last ${points.length} run(s)`);

    return lines.join('\n');
  }

  private async loadAll(): Promise<TrendDataPoint[]> {
    try {
      const content = await fs.readFile(this.trendPath, 'utf-8');
      return JSON.parse(content) as TrendDataPoint[];
    } catch {
      return [];
    }
  }
}
