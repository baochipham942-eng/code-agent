import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BundledHostCapabilityRegistry,
  type BundledHostCapabilityDescriptor,
} from '../../../../src/host/services/capabilities/bundledHostCapabilityRegistry';
import {
  canOfferRegisteredUserQuestion,
  resolveRegisteredTurnOutcome,
} from '../../../../src/host/services/capabilities/hostCapabilityPorts';
import { voiceLiveCapabilityDescriptor } from '../../../../src/host/services/voice/voiceLiveCapability';

let dataDir: string;

afterEach(async () => {
  if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
});

type HostCapabilityContext = Parameters<BundledHostCapabilityDescriptor['activate']>[0];

function cleanupHost(): HostCapabilityContext {
  const cleanup = () => undefined;
  return {
    registerIpcHandler: vi.fn(() => cleanup),
    registerWebRoute: vi.fn(() => cleanup),
    registerWebSocketUpgrade: vi.fn(() => cleanup),
    registerStartupTask: vi.fn(() => cleanup),
    registerProviderAction: vi.fn(() => cleanup),
    registerTurnOutcomeResolver: vi.fn(() => cleanup),
    registerUserQuestionRoute: vi.fn(() => cleanup),
    publishRendererCapabilityState: vi.fn(),
  };
}

describe('BundledHostCapabilityRegistry', () => {
  it('ships voice-live and voice-input installed and persists both CUA-shaped state files', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-defaults-'));
    const lifecycle = vi.fn();
    const registry = new BundledHostCapabilityRegistry({ dataDir, lifecycle });

    await registry.initialize();

    expect(await registry.listStates()).toEqual([
      { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 2 },
      { id: 'builtin.voice-input', installed: true, version: '1.0.0', revision: 2 },
    ]);
    for (const file of ['voice-live.json', 'voice-input.json']) {
      const state = JSON.parse(await fs.readFile(path.join(dataDir, 'capabilities', file), 'utf8'));
      expect(state).toMatchObject({ schemaVersion: 1, state: 'installed', version: '1.0.0', revision: 2 });
    }
    expect(lifecycle.mock.calls.map(([id, action]) => [id, action])).toEqual([
      ['builtin.voice-live', 'loaded'],
      ['builtin.voice-input', 'loaded'],
    ]);

    await registry.uninstall('builtin.voice-input');
    await registry.uninstall('builtin.voice-live');
  });

  it('rolls back registered contributions in reverse order and restores the previous state', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-rollback-'));
    const lifecycle = vi.fn();
    const resolver = vi.fn(async () => 'done' as const);
    const descriptor: BundledHostCapabilityDescriptor = {
      id: 'builtin.voice-live',
      version: '1.0.0',
      dependencies: [],
      permissions: ['microphone'],
      async activate(host) {
        host.registerTurnOutcomeResolver(resolver);
        host.registerUserQuestionRoute({ canOffer: () => true, offer: () => true, cancel: () => undefined });
        throw new Error('second contribution failed');
      },
    };
    const registry = new BundledHostCapabilityRegistry({ dataDir, descriptors: [descriptor], lifecycle });

    await expect(registry.install('builtin.voice-live')).rejects.toThrow('second contribution failed');

    expect(await resolveRegisteredTurnOutcome('session-1', 1)).toBe('unverified');
    expect(resolver).not.toHaveBeenCalled();
    expect(canOfferRegisteredUserQuestion('session-1')).toBe(false);
    await expect(registry.listStates()).resolves.toEqual([
      { id: 'builtin.voice-live', installed: false, version: '1.0.0', revision: 0 },
    ]);
    await expect(fs.stat(path.join(dataDir, 'capabilities', 'voice-live.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(lifecycle.mock.calls.map(([, action]) => action)).toEqual(['failed', 'rolled_back']);
  });

  it('runs descriptor cleanup before revoking its registered ports', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-cleanup-'));
    const order: string[] = [];
    const descriptor: BundledHostCapabilityDescriptor = {
      id: 'builtin.voice-live',
      version: '1.0.0',
      dependencies: [],
      permissions: [],
      async activate(host) {
        const cleanupResolver = host.registerTurnOutcomeResolver(async () => 'done');
        const cleanupQuestion = host.registerUserQuestionRoute({
          canOffer: () => true,
          offer: () => true,
          cancel: () => undefined,
        });
        return async () => {
          order.push('descriptor');
          await cleanupQuestion();
          order.push('question');
          await cleanupResolver();
          order.push('resolver');
        };
      },
    };
    const registry = new BundledHostCapabilityRegistry({ dataDir, descriptors: [descriptor], lifecycle: vi.fn() });
    await registry.install('builtin.voice-live');

    await registry.uninstall('builtin.voice-live');

    expect(order).toEqual(['descriptor', 'question', 'resolver']);
    expect(canOfferRegisteredUserQuestion('session-1')).toBe(false);
    expect(await resolveRegisteredTurnOutcome('session-1', 1)).toBe('unverified');
  });

  it('voice-live descriptor wires only the two P0 ports and state projection', async () => {
    const host = cleanupHost();

    const cleanup = await voiceLiveCapabilityDescriptor.activate(host);

    expect(host.registerTurnOutcomeResolver).toHaveBeenCalledOnce();
    expect(host.registerUserQuestionRoute).toHaveBeenCalledOnce();
    expect(host.publishRendererCapabilityState).toHaveBeenCalledOnce();
    expect(host.registerIpcHandler).not.toHaveBeenCalled();
    expect(host.registerWebRoute).not.toHaveBeenCalled();
    expect(host.registerWebSocketUpgrade).not.toHaveBeenCalled();
    expect(host.registerStartupTask).not.toHaveBeenCalled();
    expect(host.registerProviderAction).not.toHaveBeenCalled();
    await cleanup();
  });
});
