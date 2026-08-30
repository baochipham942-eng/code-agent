import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
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
import { voiceInputCapabilityDescriptor } from '../../../../src/host/services/speech/voiceInputCapability';
import { attachHostWebSocketUpgradeDispatcher } from '../../../../src/host/services/capabilities/hostCapabilityContributions';
import { DICTATION_STREAM_WS_PATH } from '../../../../src/shared/constants/voice';

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
    registerShortcut: vi.fn(() => cleanup),
    registerStartupTask: vi.fn(() => cleanup),
    registerProviderAction: vi.fn(() => cleanup),
    registerTurnOutcomeResolver: vi.fn(() => cleanup),
    registerUserQuestionRoute: vi.fn(() => cleanup),
    publishRendererCapabilityState: vi.fn(),
  };
}

describe('BundledHostCapabilityRegistry', () => {
  it('ships voice-input removed by default without activating its contribution surface', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-defaults-'));
    const lifecycle = vi.fn();
    const ipcMain = { handle: vi.fn(), removeHandler: vi.fn() };
    const server = attachHostWebSocketUpgradeDispatcher(new EventEmitter() as never) as unknown as EventEmitter;
    const emitUpgrade = () => {
      const socket = { write: vi.fn(), destroy: vi.fn() };
      server.emit('upgrade', { url: DICTATION_STREAM_WS_PATH }, socket, Buffer.alloc(0));
      return socket;
    };
    const registry = new BundledHostCapabilityRegistry({ dataDir, lifecycle, ipcMain: ipcMain as never });

    await registry.initialize();

    expect(await registry.listStates()).toEqual([
      { id: 'builtin.voice-live', installed: true, version: '1.0.0', revision: 2 },
      { id: 'builtin.voice-input', installed: false, version: '1.0.0', revision: 1 },
    ]);
    const liveState = JSON.parse(await fs.readFile(path.join(dataDir, 'capabilities', 'voice-live.json'), 'utf8'));
    const inputState = JSON.parse(await fs.readFile(path.join(dataDir, 'capabilities', 'voice-input.json'), 'utf8'));
    expect(liveState).toMatchObject({ schemaVersion: 1, state: 'installed', revision: 2, source: 'default' });
    expect(inputState).toMatchObject({ schemaVersion: 1, state: 'removed', revision: 1, source: 'default' });
    expect(lifecycle.mock.calls.map(([id, action]) => [id, action])).toEqual([
      ['builtin.voice-live', 'loaded'],
    ]);
    expect(ipcMain.handle).not.toHaveBeenCalled();
    expect(emitUpgrade().destroy).not.toHaveBeenCalled();
    await registry.install('builtin.voice-input', { source: 'user' });
    expect(ipcMain.handle).toHaveBeenCalledTimes(4);
    expect(emitUpgrade().destroy).toHaveBeenCalledOnce();
    await registry.uninstall('builtin.voice-input');
    expect(ipcMain.removeHandler).toHaveBeenCalledTimes(4);
    expect(emitUpgrade().destroy).not.toHaveBeenCalled();

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

  it('keeps unused contribution surfaces fail-loud', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-placeholder-'));
    const descriptor: BundledHostCapabilityDescriptor = {
      id: 'builtin.voice-input',
      version: '1.0.0',
      dependencies: [],
      permissions: [],
      async activate(host) {
        host.registerProviderAction({ action: 'unsupported' });
        return () => undefined;
      },
    };
    const registry = new BundledHostCapabilityRegistry({
      dataDir,
      descriptors: [descriptor],
      lifecycle: vi.fn(),
    });

    await expect(registry.install('builtin.voice-input')).rejects.toThrow(
      'provider action contributions are reserved',
    );
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
    expect(host.registerShortcut).not.toHaveBeenCalled();
    expect(host.registerStartupTask).not.toHaveBeenCalled();
    expect(host.registerProviderAction).not.toHaveBeenCalled();
    await cleanup();
  });

  it('voice-input descriptor owns IPC, WebSocket, shortcut, permissions, and state publication', async () => {
    const host = cleanupHost();

    const cleanup = await voiceInputCapabilityDescriptor.activate(host);

    expect(voiceInputCapabilityDescriptor.permissions).toEqual([
      'microphone',
      'network',
      'clipboard',
      'accessibility',
      'shell',
    ]);
    expect(host.registerIpcHandler).toHaveBeenCalledTimes(2);
    expect(host.registerWebSocketUpgrade).toHaveBeenCalledOnce();
    expect(host.registerShortcut).toHaveBeenCalledOnce();
    expect(host.publishRendererCapabilityState).toHaveBeenCalledOnce();
    await cleanup();
  });

  it('refuses uninstall before cleanup while capability work is active', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-active-'));
    const cleanup = vi.fn();
    const descriptor: BundledHostCapabilityDescriptor = {
      id: 'builtin.voice-input',
      version: '1.0.0',
      dependencies: [],
      permissions: ['microphone'],
      beforeUninstall() {
        throw new Error('语音输入正在录音或转写，请结束当前听写后再卸载。');
      },
      async activate(host) {
        host.publishRendererCapabilityState();
        return cleanup;
      },
    };
    const registry = new BundledHostCapabilityRegistry({
      dataDir,
      descriptors: [descriptor],
      lifecycle: vi.fn(),
    });
    await registry.install('builtin.voice-input');

    await expect(registry.uninstall('builtin.voice-input')).rejects.toThrow('正在录音或转写');
    expect(cleanup).not.toHaveBeenCalled();
    await expect(registry.listStates()).resolves.toEqual([
      { id: 'builtin.voice-input', installed: true, version: '1.0.0', revision: 2 },
    ]);
  });

  it('accounts legacy migration installs as loaded with migration detail', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-migration-'));
    const lifecycle = vi.fn();
    const descriptor: BundledHostCapabilityDescriptor = {
      id: 'builtin.voice-input',
      version: '1.0.0',
      dependencies: [],
      permissions: [],
      async activate(host) {
        host.publishRendererCapabilityState();
        return () => undefined;
      },
    };
    const registry = new BundledHostCapabilityRegistry({
      dataDir,
      descriptors: [descriptor],
      lifecycle,
      migration: async ({ installVoiceInput }) => installVoiceInput(),
    });

    await registry.initialize();

    expect(lifecycle).toHaveBeenCalledWith(
      'builtin.voice-input',
      'loaded',
      'migration:legacy-usage',
    );
  });

  it('projects missing whisper assets to Groq fallback or local-only not-ready', async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-bundled-host-readiness-'));
    const missing = {
      binaryAvailable: false,
      modelAvailable: false,
      modelFileName: 'ggml-small.bin',
      installCommand: 'brew install whisper-cpp',
    };

    const localFirst = new BundledHostCapabilityRegistry({
      dataDir,
      readSpeechMode: () => 'local-first',
      readWhisperReadiness: async () => missing,
    });
    const localOnly = new BundledHostCapabilityRegistry({
      dataDir,
      readSpeechMode: () => 'local-only',
      readWhisperReadiness: async () => missing,
    });

    await expect(localFirst.getReadiness('builtin.voice-input')).resolves.toMatchObject({
      status: 'fallback',
      installCommand: 'brew install whisper-cpp',
      preservesExternalAssetsOnUninstall: true,
    });
    await expect(localOnly.getReadiness('builtin.voice-input')).resolves.toMatchObject({
      status: 'not_ready',
      installCommand: 'brew install whisper-cpp',
      preservesExternalAssetsOnUninstall: true,
    });
  });
});
