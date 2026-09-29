import nativeFs, { promises as fs } from 'fs';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');

import {
  FolderTrustService,
  closeFolderTrustService,
  isProjectConfigTrusted,
  isProjectConfigTrustedSync,
  resetFolderTrustServiceForTest,
} from '../../../src/host/security/folderTrustService';
import { configureFolderTrustService } from '../../../src/host/security/folderTrustServiceConfig';
import type { DangerousConfigKind, FolderTrustEvaluation } from '../../../src/host/security/folderTrustService';

async function writeFile(filePath: string, content = '{}'): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf-8');
}

function trustedFromEvaluation(evaluation: FolderTrustEvaluation, kind?: DangerousConfigKind): boolean {
  if (evaluation.state === 'trusted') return true;
  if (!kind || evaluation.state !== 'untrusted') return false;
  const ofKind = evaluation.dangerousItems.filter((item) => item.kind === kind);
  return ofKind.length > 0 && ofKind.every((item) => !item.gated);
}

async function measureSyncBlock(fn: () => void): Promise<{ syncMs: number; loopMaxMs: number }> {
  const histogram = monitorEventLoopDelay({ resolution: 4 });
  histogram.enable();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  histogram.reset();
  const started = performance.now();
  fn();
  const syncMs = performance.now() - started;
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  histogram.disable();
  return { syncMs, loopMaxMs: histogram.max / 1e6 };
}

const STARTUP_SYNC_BUDGET_MS = 100;
const HOT_KINDS: DangerousConfigKind[] = [
  'project-skill-preferences',
  'project-profile',
  'project-policy',
];

describe('FolderTrustService startup event-loop stall', () => {
  let tmpRoot: string;
  let dataDir: string;
  let projectDir: string;
  let deepRoot: string;
  let originalReaddirSync = nativeFs.readdirSync;
  const deepReads: string[] = [];

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'folder-trust-stall-'));
    dataDir = path.join(tmpRoot, 'data');
    projectDir = path.join(tmpRoot, 'project');
    deepRoot = path.join(projectDir, 'deep');
    await fs.mkdir(projectDir, { recursive: true });
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
    closeFolderTrustService();
    configureFolderTrustService({});

    for (let i = 0; i < 24; i += 1) {
      for (let j = 0; j < 24; j += 1) {
        const dir = path.join(deepRoot, `p${i}`, `s${j}`);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, 'note.ts'), 'export {}\n');
      }
    }
    await writeFile(path.join(deepRoot, 'p0', 's0', 'AGENTS.md'), '# buried agent instructions\n');
    await writeFile(path.join(projectDir, '.code-agent', 'skill-preferences.json'), JSON.stringify({
      version: 1,
      overrides: { keep: true, drop: false },
    }));
    await writeFile(path.join(projectDir, '.code-agent', 'PROFILE.md'), 'PROJECT_PROFILE_MARKER');
    projectDir = await fs.realpath(projectDir);
    deepRoot = await fs.realpath(deepRoot);

    deepReads.length = 0;
    originalReaddirSync = nativeFs.readdirSync;
    nativeFs.readdirSync = ((
      target: nativeFs.PathLike,
      options?: Parameters<typeof nativeFs.readdirSync>[1],
    ) => {
      const resolved = String(target);
      if (resolved === deepRoot || resolved.startsWith(`${deepRoot}${path.sep}`)) {
        deepReads.push(resolved);
      }
      return Reflect.apply(originalReaddirSync, nativeFs, options === undefined ? [target] : [target, options]);
    }) as typeof nativeFs.readdirSync;
  });

  afterEach(async () => {
    nativeFs.readdirSync = originalReaddirSync;
    resetFolderTrustServiceForTest();
    vi.unstubAllEnvs();
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  it('evaluateSync still walks the buried tree (the stall the trust gate must not take)', () => {
    const service = new FolderTrustService();
    deepReads.length = 0;
    const evaluation = service.evaluateSync(projectDir);
    expect(deepReads.length).toBeGreaterThan(50);
    expect(evaluation.dangerousItems.some((item) => item.kind === 'agent-instructions')).toBe(true);
    service.close();
  });

  it('isProjectConfigTrustedSync skips the buried tree and stays within the event-loop budget', async () => {
    const service = new FolderTrustService();
    deepReads.length = 0;
    const measured = await measureSyncBlock(() => {
      for (const kind of HOT_KINDS) {
        isProjectConfigTrustedSync(projectDir, kind);
      }
    });
    expect(deepReads).toEqual([]);
    expect(measured.syncMs).toBeLessThan(STARTUP_SYNC_BUDGET_MS);
    expect(measured.loopMaxMs).toBeLessThan(STARTUP_SYNC_BUDGET_MS);
    service.close();
  });

  it('trust-gate boolean matches full evaluateSync for startup kinds', () => {
    const service = new FolderTrustService();
    const full = service.evaluateSync(projectDir);
    for (const kind of HOT_KINDS) {
      expect(isProjectConfigTrustedSync(projectDir, kind)).toBe(trustedFromEvaluation(full, kind));
    }

    service.setSync(projectDir, 'trusted', 'test');
    const trusted = service.evaluateSync(projectDir);
    expect(trusted.state).toBe('trusted');
    for (const kind of HOT_KINDS) {
      expect(isProjectConfigTrustedSync(projectDir, kind)).toBe(true);
      expect(trustedFromEvaluation(trusted, kind)).toBe(true);
    }

    service.revokeSync(projectDir);
    const blocked = service.evaluateSync(projectDir);
    expect(blocked.state).toBe('blocked');
    for (const kind of HOT_KINDS) {
      expect(isProjectConfigTrustedSync(projectDir, kind)).toBe(false);
      expect(trustedFromEvaluation(blocked, kind)).toBe(false);
    }
    service.close();
  });

  it('still sees a newly dropped policy file after the scan TTL (contentChanged)', async () => {
    const service = new FolderTrustService();
    service.setSync(projectDir, 'trusted', 'create-space');
    expect(isProjectConfigTrustedSync(projectDir, 'project-policy')).toBe(true);

    await writeFile(path.join(projectDir, 'code-agent-policy.toml'), '[execution]\nallow_shell = true\n');
    expect(isProjectConfigTrustedSync(projectDir, 'project-policy')).toBe(true);

    const readsBeforeExpiry = deepReads.length;
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow + 10_000);
    try {
      expect(isProjectConfigTrustedSync(projectDir, 'project-policy')).toBe(false);
      expect(deepReads.length).toBe(readsBeforeExpiry);
    } finally {
      nowSpy.mockRestore();
    }
    service.close();
  });

  it('async evaluate still finds buried AGENTS.md and agrees with the trust gate', async () => {
    const service = new FolderTrustService();
    const evaluation = await service.evaluate(projectDir);
    expect(evaluation.dangerousItems.some((item) => item.path.endsWith('AGENTS.md'))).toBe(true);
    expect(await isProjectConfigTrusted(projectDir, 'project-skill-preferences')).toBe(
      isProjectConfigTrustedSync(projectDir, 'project-skill-preferences'),
    );
    expect(await isProjectConfigTrusted(projectDir, 'project-profile')).toBe(
      isProjectConfigTrustedSync(projectDir, 'project-profile'),
    );
    service.close();
  });
});
