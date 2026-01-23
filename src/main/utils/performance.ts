// ============================================================================
// Performance Utilities - Monitoring and profiling helpers
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('Performance');

// ----------------------------------------------------------------------------
// Timing Utilities
// ----------------------------------------------------------------------------

/**
 * High-resolution timer for performance measurements
 */
export class Timer {
  private startTime: number;
  private endTime?: number;
  private marks: Map<string, number> = new Map();

  constructor() {
    this.startTime = performance.now();
  }

  /**
   * Mark a point in time with a label
   */
  mark(label: string): void {
    this.marks.set(label, performance.now());
  }

  /**
   * Get elapsed time since start in milliseconds
   */
  elapsed(): number {
    return performance.now() - this.startTime;
  }

  /**
   * Get elapsed time since a mark
   */
  elapsedSince(label: string): number | undefined {
    const markTime = this.marks.get(label);
    if (markTime === undefined) return undefined;
    return performance.now() - markTime;
  }

  /**
   * Stop the timer and return total duration
   */
  stop(): number {
    this.endTime = performance.now();
    return this.endTime - this.startTime;
  }

  /**
   * Get all marks with their elapsed times
   */
  getMarks(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [label, time] of this.marks) {
      result[label] = time - this.startTime;
    }
    return result;
  }
}

/**
 * Measure execution time of an async function
 */
export async function measureAsync<T>(
  fn: () => Promise<T>,
  label?: string
): Promise<{ result: T; duration: number }> {
  const timer = new Timer();
  const result = await fn();
  const duration = timer.stop();

  if (label) {
    logger.debug(`${label}: ${duration.toFixed(2)}ms`);
  }

  return { result, duration };
}

/**
 * Create a timed wrapper for a function
 */
export function withTiming<T extends (...args: any[]) => Promise<any>>(
  fn: T,
  label: string
): T {
  return (async (...args: Parameters<T>) => {
    const timer = new Timer();
    try {
      return await fn(...args);
    } finally {
      const duration = timer.stop();
      logger.debug(`${label}: ${duration.toFixed(2)}ms`);
    }
  }) as T;
}

// ----------------------------------------------------------------------------
// Memory Utilities
// ----------------------------------------------------------------------------

/**
 * Memory usage snapshot
 */
export interface MemorySnapshot {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  timestamp: number;
}

/**
 * Get current memory usage
 */
export function getMemoryUsage(): MemorySnapshot {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
    timestamp: Date.now(),
  };
}

/**
 * Format bytes to human readable
 */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }

  return `${value.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Memory monitor for tracking changes over time
 */
export class MemoryMonitor {
  private snapshots: MemorySnapshot[] = [];
  private maxSnapshots: number;

  constructor(maxSnapshots: number = 100) {
    this.maxSnapshots = maxSnapshots;
  }

  /**
   * Take a memory snapshot
   */
  snapshot(): MemorySnapshot {
    const snap = getMemoryUsage();
    this.snapshots.push(snap);

    // Keep only the most recent snapshots
    if (this.snapshots.length > this.maxSnapshots) {
      this.snapshots.shift();
    }

    return snap;
  }

  /**
   * Get memory growth since first snapshot
   */
  getGrowth(): number {
    if (this.snapshots.length < 2) return 0;
    const first = this.snapshots[0];
    const last = this.snapshots[this.snapshots.length - 1];
    return last.heapUsed - first.heapUsed;
  }

  /**
   * Check for potential memory leak
   * Returns true if memory has grown consistently
   */
  detectLeak(threshold: number = 10 * 1024 * 1024): boolean {
    if (this.snapshots.length < 10) return false;

    // Check if heap has consistently grown
    const recentSnapshots = this.snapshots.slice(-10);
    let growthCount = 0;

    for (let i = 1; i < recentSnapshots.length; i++) {
      if (recentSnapshots[i].heapUsed > recentSnapshots[i - 1].heapUsed) {
        growthCount++;
      }
    }

    // If memory grew in 8+ of last 10 snapshots and total growth exceeds threshold
    const totalGrowth = recentSnapshots[recentSnapshots.length - 1].heapUsed - recentSnapshots[0].heapUsed;
    return growthCount >= 8 && totalGrowth > threshold;
  }

  /**
   * Get summary report
   */
  getSummary(): {
    current: MemorySnapshot;
    growth: number;
    snapshots: number;
    leakDetected: boolean;
  } {
    return {
      current: this.snapshots[this.snapshots.length - 1] || getMemoryUsage(),
      growth: this.getGrowth(),
      snapshots: this.snapshots.length,
      leakDetected: this.detectLeak(),
    };
  }

  /**
   * Clear all snapshots
   */
  clear(): void {
    this.snapshots = [];
  }
}

// ----------------------------------------------------------------------------
// Performance Markers
// ----------------------------------------------------------------------------

/**
 * Performance marker for Chrome DevTools profiling
 */
export function mark(name: string): void {
  if (typeof performance !== 'undefined' && performance.mark) {
    performance.mark(name);
  }
}

/**
 * Measure between two marks
 */
export function measure(name: string, startMark: string, endMark: string): void {
  if (typeof performance !== 'undefined' && performance.measure) {
    try {
      performance.measure(name, startMark, endMark);
    } catch {
      // Marks may not exist
    }
  }
}

/**
 * Clear all performance marks and measures
 */
export function clearMarks(): void {
  if (typeof performance !== 'undefined') {
    if (performance.clearMarks) performance.clearMarks();
    if (performance.clearMeasures) performance.clearMeasures();
  }
}

// ----------------------------------------------------------------------------
// Throttling and Debouncing
// ----------------------------------------------------------------------------

/**
 * Throttle function execution
 */
export function throttle<T extends (...args: any[]) => any>(
  fn: T,
  limit: number
): T {
  let lastCall = 0;

  return ((...args: Parameters<T>) => {
    const now = Date.now();
    if (now - lastCall >= limit) {
      lastCall = now;
      return fn(...args);
    }
  }) as T;
}

/**
 * Debounce function execution
 */
export function debounce<T extends (...args: any[]) => any>(
  fn: T,
  delay: number
): T {
  let timeoutId: NodeJS.Timeout | undefined;

  return ((...args: Parameters<T>) => {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      fn(...args);
      timeoutId = undefined;
    }, delay);
  }) as T;
}

// ----------------------------------------------------------------------------
// Resource Cleanup Tracker
// ----------------------------------------------------------------------------

/**
 * Track resources that need cleanup to prevent leaks
 */
export class ResourceTracker {
  private resources: Map<string, () => void> = new Map();
  private cleanupCallbacks: Array<() => void> = [];

  /**
   * Register a resource for cleanup
   */
  register(id: string, cleanup: () => void): void {
    this.resources.set(id, cleanup);
  }

  /**
   * Unregister a resource (already cleaned up)
   */
  unregister(id: string): void {
    this.resources.delete(id);
  }

  /**
   * Add a cleanup callback
   */
  onCleanup(callback: () => void): void {
    this.cleanupCallbacks.push(callback);
  }

  /**
   * Clean up all registered resources
   */
  cleanup(): void {
    for (const [id, cleanupFn] of this.resources) {
      try {
        cleanupFn();
      } catch (error) {
        logger.warn(`Failed to cleanup resource ${id}`, { error });
      }
    }
    this.resources.clear();

    for (const callback of this.cleanupCallbacks) {
      try {
        callback();
      } catch (error) {
        logger.warn('Cleanup callback failed', { error });
      }
    }
    this.cleanupCallbacks = [];
  }

  /**
   * Get count of tracked resources
   */
  get size(): number {
    return this.resources.size;
  }
}
