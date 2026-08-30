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
      evidenceReader: { read: async () => evidence },
    });

    expect(installVoiceInput).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    expect(marker).toMatchObject({
      schemaVersion: 1,
      voiceInput: { status: 'completed', evidence, detail: 'migration:legacy-usage' },
      voiceLive: { status: 'pending' },
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
      evidenceReader,
    });

    expect(evidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceInput).not.toHaveBeenCalled();
    await expect(readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input')).resolves.toMatchObject({
      record: { state: 'removed', revision: 7, source: 'user' },
    });
  });

  it('marks the voice-input half failed and keeps voice-live pending when evidence collection fails', async () => {
    const dataDir = await makeDataDir();

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      evidenceReader: { read: async () => { throw new Error('database unavailable'); } },
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
      voiceLive: { status: 'pending' },
    });
  });
});
