import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  runVoiceCapabilityMigrationV1,
} from '../../../../src/host/services/capabilities/voiceCapabilityMigrationV1';
import {
  readBundledHostCapabilityInstallSnapshot,
  writeBundledHostCapabilityInstallState,
} from '../../../../src/host/services/capabilities/bundledHostCapabilityInstallState';

const dataDirs: string[] = [];

async function makeDataDir(): Promise<string> {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-voice-migration-'));
  dataDirs.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  await Promise.all(dataDirs.splice(0).map((dataDir) => fs.rm(dataDir, { recursive: true, force: true })));
});

describe('voice-capability-migration-v1 voice-input half', () => {
  const cases = [
    ['messageMetadata', { messageMetadata: true, nonDefaultSpeechSettings: false, retainedFailureAudio: false }],
    ['nonDefaultSpeechSettings', { messageMetadata: false, nonDefaultSpeechSettings: true, retainedFailureAudio: false }],
    ['retainedFailureAudio', { messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: true }],
  ] as const;

  it.each(cases)('installs for independent legacy evidence: %s', async (_name, evidence) => {
    const dataDir = await makeDataDir();
    const installVoiceInput = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput,
      installVoiceLive: vi.fn(),
      evidenceReader: { read: async () => evidence },
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false }) },
    });

    expect(installVoiceInput).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    expect(marker).toMatchObject({
      schemaVersion: 1,
      voiceInput: { status: 'completed', evidence, detail: 'migration:legacy-usage' },
      voiceLive: { status: 'completed', detail: 'no-legacy-usage' },
    });
  });

  it('preserves an explicit uninstall and does not read legacy evidence again', async () => {
    const dataDir = await makeDataDir();
    await writeBundledHostCapabilityInstallState(
      dataDir,
      'builtin.voice-input',
      'removed',
      '1.0.0',
      7,
      'user',
    );
    const evidenceReader = { read: vi.fn(async () => {
      throw new Error('must not scan');
    }) };
    const installVoiceInput = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput,
      installVoiceLive: vi.fn(),
      evidenceReader,
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false }) },
    });

    expect(evidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceInput).not.toHaveBeenCalled();
    await expect(readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input')).resolves.toMatchObject({
      record: { state: 'removed', revision: 7, source: 'user' },
    });
  });

  it('marks the voice-input half failed while allowing the voice-live half to complete', async () => {
    const dataDir = await makeDataDir();

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      installVoiceLive: vi.fn(),
      evidenceReader: { read: async () => { throw new Error('database unavailable'); } },
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false }) },
    });

    await expect(readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input')).resolves.toMatchObject({
      record: { state: 'removed', source: 'migration-failed' },
    });
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    expect(marker).toMatchObject({
      voiceInput: { status: 'failed', detail: 'database unavailable' },
      voiceLive: { status: 'completed', detail: 'no-legacy-usage' },
    });
  });

  it.each([
    ['voiceCallHistory', { voiceCallHistory: true, nonDefaultRealtimeSettings: false }],
    ['nonDefaultRealtimeSettings', { voiceCallHistory: false, nonDefaultRealtimeSettings: true }],
  ] as const)('installs voice-live for independent legacy evidence: %s', async (_name, evidence) => {
    const dataDir = await makeDataDir();
    const installVoiceLive = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      installVoiceLive,
      evidenceReader: { read: async () => ({ messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false }) },
      liveEvidenceReader: { read: async () => evidence },
    });

    expect(installVoiceLive).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    expect(marker.voiceLive).toMatchObject({ status: 'completed', evidence, detail: 'migration:legacy-usage' });
  });

  it('preserves an explicit voice-live uninstall over historical evidence', async () => {
    const dataDir = await makeDataDir();
    await writeBundledHostCapabilityInstallState(dataDir, 'builtin.voice-live', 'removed', '1.0.0', 4, 'user');
    const liveEvidenceReader = { read: vi.fn(async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: true })) };
    const installVoiceLive = vi.fn();

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      installVoiceLive,
      evidenceReader: { read: async () => ({ messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false }) },
      liveEvidenceReader,
    });

    expect(liveEvidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceLive).not.toHaveBeenCalled();
    await expect(readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-live')).resolves.toMatchObject({
      record: { state: 'removed', revision: 4, source: 'user' },
    });
  });

  it('continues voice-live from the P1a pending marker without rescanning voice-input', async () => {
    const dataDir = await makeDataDir();
    const markerFile = path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json');
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, JSON.stringify({
      schemaVersion: 1,
      voiceInput: {
        status: 'completed',
        evidence: { messageMetadata: true, nonDefaultSpeechSettings: false, retainedFailureAudio: false },
        detail: 'migration:legacy-usage',
      },
      voiceLive: { status: 'pending' },
      updatedAt: 1,
    }));
    const inputEvidenceReader = { read: vi.fn() };
    const installVoiceInput = vi.fn();
    const installVoiceLive = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput,
      installVoiceLive,
      evidenceReader: inputEvidenceReader,
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: false }) },
    });

    expect(inputEvidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceInput).not.toHaveBeenCalled();
    expect(installVoiceLive).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    expect(marker.voiceLive).toMatchObject({ status: 'completed', detail: 'migration:legacy-usage' });
  });
});
