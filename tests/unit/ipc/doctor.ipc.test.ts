import { describe, it, expect } from 'vitest';
import { runDiagnostics } from '../../../src/main/ipc/doctor.ipc';
import type { DiagnosticItem, DiagnosticReport } from '../../../src/main/ipc/doctor.ipc';

const VALID_STATUSES = new Set<DiagnosticItem['status']>(['pass', 'warn', 'fail']);
const VALID_CATEGORIES = new Set<DiagnosticItem['category']>(['environment', 'network', 'config', 'database', 'disk']);

describe('runDiagnostics()', () => {
  it('returns a DiagnosticReport with required top-level fields', async () => {
    const report = await runDiagnostics();
    expect(report).toHaveProperty('timestamp');
    expect(report).toHaveProperty('items');
    expect(report).toHaveProperty('summary');
    expect(Array.isArray(report.items)).toBe(true);
  });

  it('timestamp is recent (within 5 seconds of now)', async () => {
    const before = Date.now();
    const report = await runDiagnostics();
    const after = Date.now();
    expect(report.timestamp).toBeGreaterThanOrEqual(before);
    expect(report.timestamp).toBeLessThanOrEqual(after + 5000);
  });

  it('summary counts match actual item statuses', async () => {
    const report = await runDiagnostics();
    const counted = { pass: 0, warn: 0, fail: 0 };
    for (const item of report.items) {
      counted[item.status]++;
    }
    expect(report.summary.pass).toBe(counted.pass);
    expect(report.summary.warn).toBe(counted.warn);
    expect(report.summary.fail).toBe(counted.fail);
  });

  it('Node.js version check passes for current environment (>= 18)', async () => {
    const report = await runDiagnostics();
    const nodeItem = report.items.find(i => i.name === 'Node.js version');
    expect(nodeItem).toBeDefined();
    expect(nodeItem!.status).toBe('pass');
    expect(nodeItem!.message).toContain('Node.js');
  });

  it('every item has required fields: category, name, status, message', async () => {
    const report = await runDiagnostics();
    for (const item of report.items) {
      expect(item).toHaveProperty('category');
      expect(item).toHaveProperty('name');
      expect(item).toHaveProperty('status');
      expect(item).toHaveProperty('message');
      expect(typeof item.category).toBe('string');
      expect(typeof item.name).toBe('string');
      expect(typeof item.message).toBe('string');
    }
  });

  it('all item statuses are valid values', async () => {
    const report = await runDiagnostics();
    for (const item of report.items) {
      expect(VALID_STATUSES.has(item.status)).toBe(true);
    }
  });

  it('all item categories are valid values', async () => {
    const report = await runDiagnostics();
    for (const item of report.items) {
      expect(VALID_CATEGORIES.has(item.category)).toBe(true);
    }
  });

  it('returns at least 4 diagnostic items', async () => {
    const report = await runDiagnostics();
    expect(report.items.length).toBeGreaterThanOrEqual(4);
  });
});
