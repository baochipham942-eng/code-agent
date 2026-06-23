import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import {
  PlanPersistence,
  createPlanPersistence,
  type PersistenceConfig,
} from '../../../src/main/planning/planPersistence';
import { CONFIG_DIR_NEW } from '../../../src/main/config/configPaths';
import type { TaskPlan } from '../../../src/main/planning/types';

let workingDirectory: string;
const SESSION_ID = 'sess-persist';

const makeConfig = (over: Partial<PersistenceConfig> = {}): PersistenceConfig => ({
  workingDirectory,
  sessionId: SESSION_ID,
  maxSnapshots: 10,
  autoSnapshot: true,
  snapshotInterval: 5 * 60 * 1000,
  ...over,
});

const makePlan = (over: Partial<TaskPlan> = {}): TaskPlan => ({
  id: 'plan-1',
  title: 'Plan',
  objective: 'obj',
  phases: [],
  createdAt: 1,
  updatedAt: 2,
  metadata: { totalSteps: 4, completedSteps: 1, blockedSteps: 0 },
  ...over,
});

const snapshotDir = () =>
  path.join(workingDirectory, CONFIG_DIR_NEW, 'snapshots', SESSION_ID);

beforeEach(async () => {
  workingDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'plan-persist-'));
});

afterEach(async () => {
  await fs.rm(workingDirectory, { recursive: true, force: true });
});

describe('PlanPersistence snapshots', () => {
  it('createSnapshot persists to disk and records file hashes', async () => {
    await fs.writeFile(path.join(workingDirectory, 'tracked.ts'), 'content');
    const p = await createPlanPersistence(makeConfig());

    const snap = await p.createSnapshot(makePlan(), 'first', ['tracked.ts', 'missing.ts']);
    expect(snap.id).toMatch(/^snap_/);
    expect(snap.fileStates.get('tracked.ts')).toBeTruthy();
    expect(snap.fileStates.has('missing.ts')).toBe(false); // missing file silently skipped

    const onDisk = await fs.readdir(snapshotDir());
    expect(onDisk).toContain(`${snap.id}.json`);
  });

  it('reloads persisted snapshots in a fresh instance, sorted by createdAt', async () => {
    const writer = await createPlanPersistence(makeConfig());
    await writer.createSnapshot(makePlan(), 'one');
    await writer.createSnapshot(makePlan(), 'two');

    const reader = await createPlanPersistence(makeConfig());
    const available = reader.getAvailableSnapshots();
    expect(available).toHaveLength(2);
    expect(available[0].createdAt).toBeLessThanOrEqual(available[1].createdAt);
    expect(available[0].planProgress).toBeCloseTo(25); // 1/4 * 100
  });

  it('evicts the oldest snapshot beyond maxSnapshots', async () => {
    const p = await createPlanPersistence(makeConfig({ maxSnapshots: 2 }));
    await p.createSnapshot(makePlan(), 's1');
    await p.createSnapshot(makePlan(), 's2');
    await p.createSnapshot(makePlan(), 's3');

    const available = p.getAvailableSnapshots();
    expect(available).toHaveLength(2);
    expect(available.map((s) => s.description)).toEqual(['s2', 's3']);
    const files = await fs.readdir(snapshotDir());
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(2);
  });

  it('rollbackToSnapshot returns the stored plan state or null', async () => {
    const p = await createPlanPersistence(makeConfig());
    const snap = await p.createSnapshot(makePlan({ title: 'Snapshotted' }), 'desc');
    const restored = await p.rollbackToSnapshot(snap.id);
    expect(restored?.title).toBe('Snapshotted');
    expect(await p.rollbackToSnapshot('nope')).toBeNull();
  });
});

describe('PlanPersistence shouldAutoSnapshot', () => {
  it('is false when autoSnapshot is disabled', async () => {
    const p = await createPlanPersistence(makeConfig({ autoSnapshot: false }));
    expect(p.shouldAutoSnapshot()).toBe(false);
  });

  it('is true when the interval has elapsed since the last snapshot', async () => {
    const p = await createPlanPersistence(makeConfig({ snapshotInterval: 0 }));
    expect(p.shouldAutoSnapshot()).toBe(true);
  });

  it('is false immediately after taking a snapshot with a long interval', async () => {
    const p = await createPlanPersistence(makeConfig({ snapshotInterval: 10 ** 9 }));
    await p.createSnapshot(makePlan(), 'just now');
    expect(p.shouldAutoSnapshot()).toBe(false);
  });
});

describe('PlanPersistence checkpoints', () => {
  it('creates, looks up, and validates a passing checkpoint', async () => {
    const p = new PlanPersistence(makeConfig());
    const cp = p.createCheckpoint('ph', 'st', 'check', async () => true);
    expect(p.getCheckpointsForStep('ph', 'st')).toHaveLength(1);
    expect(await p.validateCheckpoint(cp.id)).toBe(true);
  });

  it('returns false when validation fails or throws', async () => {
    const p = new PlanPersistence(makeConfig());
    const failing = p.createCheckpoint('ph', 'st', 'fail', async () => false);
    const throwing = p.createCheckpoint('ph', 'st', 'throw', async () => {
      throw new Error('boom');
    });
    expect(await p.validateCheckpoint(failing.id)).toBe(false);
    expect(await p.validateCheckpoint(throwing.id)).toBe(false);
  });

  it('returns false for an unknown checkpoint id', async () => {
    const p = new PlanPersistence(makeConfig());
    expect(await p.validateCheckpoint('missing')).toBe(false);
  });

  it('getCheckpointsForStep filters by phase and step', () => {
    const p = new PlanPersistence(makeConfig());
    p.createCheckpoint('ph1', 's1', 'a', async () => true);
    p.createCheckpoint('ph1', 's2', 'b', async () => true);
    expect(p.getCheckpointsForStep('ph1', 's1')).toHaveLength(1);
    expect(p.getCheckpointsForStep('ph2', 's1')).toHaveLength(0);
  });
});

describe('PlanPersistence compareSnapshots', () => {
  it('reports metadata and file diffs between two snapshots', async () => {
    await fs.writeFile(path.join(workingDirectory, 'a.ts'), 'v1');
    await fs.writeFile(path.join(workingDirectory, 'removed.ts'), 'gone-later');
    const p = await createPlanPersistence(makeConfig());

    const s1 = await p.createSnapshot(
      makePlan({ metadata: { totalSteps: 4, completedSteps: 1, blockedSteps: 0 } }),
      's1',
      ['a.ts', 'removed.ts']
    );

    await fs.writeFile(path.join(workingDirectory, 'a.ts'), 'v2-changed');
    await fs.writeFile(path.join(workingDirectory, 'added.ts'), 'new');
    const s2 = await p.createSnapshot(
      makePlan({ metadata: { totalSteps: 4, completedSteps: 3, blockedSteps: 0 } }),
      's2',
      ['a.ts', 'added.ts']
    );

    const diff = await p.compareSnapshots(s1.id, s2.id);
    expect(diff.planDiffs).toContainEqual({ field: 'completedSteps', before: 1, after: 3 });
    expect(diff.fileDiffs).toContainEqual({ file: 'a.ts', status: 'modified' });
    expect(diff.fileDiffs).toContainEqual({ file: 'added.ts', status: 'added' });
    expect(diff.fileDiffs).toContainEqual({ file: 'removed.ts', status: 'removed' });
  });

  it('throws when either snapshot id is unknown', async () => {
    const p = await createPlanPersistence(makeConfig());
    const s1 = await p.createSnapshot(makePlan(), 's1');
    await expect(p.compareSnapshots(s1.id, 'missing')).rejects.toThrow('快照不存在');
  });
});

describe('PlanPersistence export/import', () => {
  it('exports a plan and re-imports it', async () => {
    const p = await createPlanPersistence(makeConfig());
    await p.createSnapshot(makePlan(), 's1');
    const outPath = path.join(workingDirectory, 'export.json');
    await p.exportPlan(makePlan({ title: 'Exported' }), outPath);

    const reimported = await p.importPlan(outPath);
    expect(reimported.title).toBe('Exported');
  });

  it('rejects an export file with an invalid plan payload', async () => {
    const p = await createPlanPersistence(makeConfig());
    const badPath = path.join(workingDirectory, 'bad.json');
    await fs.writeFile(badPath, JSON.stringify({ plan: { not: 'a plan' } }), 'utf-8');
    await expect(p.importPlan(badPath)).rejects.toThrow('Invalid plan export');
  });
});

describe('PlanPersistence storage management', () => {
  it('getStorageStats counts snapshots, checkpoints, and bytes', async () => {
    const p = await createPlanPersistence(makeConfig());
    await p.createSnapshot(makePlan(), 's1');
    p.createCheckpoint('ph', 'st', 'cp', async () => true);

    const stats = await p.getStorageStats();
    expect(stats.snapshotCount).toBe(1);
    expect(stats.checkpointCount).toBe(1);
    expect(stats.totalSize).toBeGreaterThan(0);
  });

  it('clearAllSnapshots removes snapshots, checkpoints, and files', async () => {
    const p = await createPlanPersistence(makeConfig());
    await p.createSnapshot(makePlan(), 's1');
    p.createCheckpoint('ph', 'st', 'cp', async () => true);

    await p.clearAllSnapshots();
    expect(p.getAvailableSnapshots()).toHaveLength(0);
    expect((await p.getStorageStats()).checkpointCount).toBe(0);
    const files = await fs.readdir(snapshotDir());
    expect(files.filter((f) => f.endsWith('.json'))).toHaveLength(0);
  });

  it('tolerates a corrupt snapshot file during load', async () => {
    const p1 = await createPlanPersistence(makeConfig());
    await p1.createSnapshot(makePlan(), 'good');
    await fs.writeFile(path.join(snapshotDir(), 'corrupt.json'), '{ not json', 'utf-8');

    const warn = vi.fn();
    const p2 = new PlanPersistence(makeConfig());
    await p2.initialize(); // should not throw despite the corrupt file
    expect(p2.getAvailableSnapshots()).toHaveLength(1);
    warn.mockReset();
  });
});
