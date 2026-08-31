import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InternalFeatureHostRuntime } from '../../src/host/internalFeatures/internalFeatureHostRuntime';
import { PluginRegistry } from '../../src/host/plugins/pluginRegistry';
import type { ipcHost } from '../../src/host/platform';
import { ManualCapabilityPackageService } from '../../src/host/services/capabilities/manualCapabilityPackageService';
import { packPlugin } from '../../packages/internal/evaluation-center/scripts/pack';
import { EVALUATION_CHANNELS } from '../../packages/internal/evaluation-center/src/shared/evaluationChannels';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe('evaluation-center L1 + L2 package half-step', () => {
  it('stages the real zip and activates its real host bundle after confirm', async () => {
    const archivePath = await packPlugin();
    const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-evaluation-package-halfstep-'));
    tempRoots.push(tempRoot);
    const handlers = new Map<string, unknown>();
    const ipcMain: typeof ipcHost = {
      handle: (channel, handler) => { handlers.set(channel, handler); },
      on: () => undefined,
      once: () => undefined,
      removeHandler: (channel) => { handlers.delete(channel); },
      removeAllListeners: () => undefined,
    };
    const registry = new PluginRegistry();
    const runtime = new InternalFeatureHostRuntime({
      registry,
      ipcMain,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    const service = new ManualCapabilityPackageService({
      pluginsDir: () => path.join(tempRoot, 'plugins'),
      registry,
      useOsSandbox: false,
      internalFeatureRuntime: runtime,
      isCurrentUserAdmin: () => true,
    });

    const preview = await service.stage(archivePath);
    expect(preview).toMatchObject({
      id: 'evaluation-center',
      sourceKind: 'zip',
      sandbox: { passed: true, summary: '隔离进程试跑通过，内部界面声明有效' },
    });
    process.stdout.write(`HALFSTEP_STAGE=${preview.sandbox.summary}\n`);
    await service.confirm(preview.token);

    expect(runtime.isLoaded('evaluation-center')).toBe(true);
    expect(handlers.has(EVALUATION_CHANNELS.RUN_SUITE)).toBe(true);
    process.stdout.write(`HALFSTEP_HANDLER=${EVALUATION_CHANNELS.RUN_SUITE}:registered\n`);

    await runtime.unload('evaluation-center');
    registry.pauseWatching();
  }, 60_000);
});

