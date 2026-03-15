// ============================================================================
// Session Metadata — Tracks usage patterns for context-aware responses
// Inspired by ChatGPT's Session Metadata layer.
// Stores lightweight stats in ~/.code-agent/memory/session-stats.json
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureMemoryDir, getMemoryDir } from './indexLoader';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionMetadata');

interface SessionStats {
  /** ISO date strings of active days (kept for last 30 days) */
  activeDays: string[];
  /** Total session count */
  totalSessions: number;
  /** Recent session message counts (last 15 sessions) */
  recentSessionDepths: number[];
  /** Model usage counts: { "kimi-k2.5": 42, "deepseek-chat": 10 } */
  modelUsage: Record<string, number>;
  /** Last session start time (ISO) */
  lastSessionStart: string;
}

const STATS_FILE = 'session-stats.json';
const MAX_ACTIVE_DAYS = 30;
const MAX_SESSION_DEPTHS = 15;

function getStatsPath(): string {
  return path.join(getMemoryDir(), STATS_FILE);
}

/**
 * Load session stats from disk.
 */
async function loadStats(): Promise<SessionStats> {
  try {
    const raw = await fs.readFile(getStatsPath(), 'utf-8');
    return JSON.parse(raw) as SessionStats;
  } catch {
    return {
      activeDays: [],
      totalSessions: 0,
      recentSessionDepths: [],
      modelUsage: {},
      lastSessionStart: '',
    };
  }
}

/**
 * Save session stats to disk.
 */
async function saveStats(stats: SessionStats): Promise<void> {
  await ensureMemoryDir();
  await fs.writeFile(getStatsPath(), JSON.stringify(stats, null, 2), 'utf-8');
}

/**
 * Record a new session start. Call this once at session initialization.
 */
export async function recordSessionStart(): Promise<void> {
  try {
    const stats = await loadStats();
    const today = new Date().toISOString().split('T')[0];

    // Add today to active days (deduplicated)
    if (!stats.activeDays.includes(today)) {
      stats.activeDays.push(today);
    }

    // Trim to last 30 days
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - MAX_ACTIVE_DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    stats.activeDays = stats.activeDays.filter(d => d >= cutoffStr);

    stats.totalSessions += 1;
    stats.lastSessionStart = new Date().toISOString();

    await saveStats(stats);
  } catch (err) {
    logger.error('Failed to record session start:', err);
  }
}

/**
 * Record session end with message count and model used.
 */
export async function recordSessionEnd(messageCount: number, model?: string): Promise<void> {
  try {
    const stats = await loadStats();

    // Track conversation depth
    stats.recentSessionDepths.push(messageCount);
    if (stats.recentSessionDepths.length > MAX_SESSION_DEPTHS) {
      stats.recentSessionDepths = stats.recentSessionDepths.slice(-MAX_SESSION_DEPTHS);
    }

    // Track model usage
    if (model) {
      stats.modelUsage[model] = (stats.modelUsage[model] || 0) + 1;
    }

    await saveStats(stats);
  } catch (err) {
    logger.error('Failed to record session end:', err);
  }
}

/**
 * Build session metadata block for system prompt injection.
 * Returns a compact string (~100 tokens) or null if no stats yet.
 */
export async function buildSessionMetadataBlock(): Promise<string | null> {
  try {
    const stats = await loadStats();
    if (stats.totalSessions === 0) return null;

    const today = new Date().toISOString().split('T')[0];

    // Calculate active days in windows
    const daysIn1 = stats.activeDays.filter(d => d === today).length;
    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekAgoStr = weekAgo.toISOString().split('T')[0];
    const daysIn7 = stats.activeDays.filter(d => d >= weekAgoStr).length;
    const daysIn30 = stats.activeDays.length;

    // Average conversation depth
    const avgDepth = stats.recentSessionDepths.length > 0
      ? (stats.recentSessionDepths.reduce((a, b) => a + b, 0) / stats.recentSessionDepths.length).toFixed(1)
      : 'N/A';

    // Top 3 models by usage
    const topModels = Object.entries(stats.modelUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([model, count]) => {
        const total = Object.values(stats.modelUsage).reduce((a, b) => a + b, 0);
        const pct = total > 0 ? Math.round((count / total) * 100) : 0;
        return `${model} ${pct}%`;
      })
      .join(', ');

    return `<session_metadata>
Active: ${daysIn1}/1d, ${daysIn7}/7d, ${daysIn30}/30d
Total sessions: ${stats.totalSessions}
Avg conversation depth: ${avgDepth} messages
Model distribution: ${topModels || 'N/A'}
</session_metadata>`;
  } catch (err) {
    logger.error('Failed to build session metadata:', err);
    return null;
  }
}
