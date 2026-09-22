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

// 「真实读取器路径」用例的服务边界 mock（同仓 companionLibraryRead.test.ts 惯用法）：
// 不注入 evidenceReader，让默认生产读取器真跑，判据落在结果 marker 的 evidence 上。
const readerDb = vi.hoisted(() => ({
  messages: [] as Array<{ metadata: unknown }>,
}));
const readerGetApiKey = vi.hoisted(() => vi.fn<(provider: string) => string | undefined>());

vi.mock('../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    isReady: true,
    listSessions: () => [{ id: 'legacy' }],
    getMessages: () => readerDb.messages,
    hasCompanionCommandAction: () => false,
    listVoiceCallSummaries: () => [],
  }),
}));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ onSettingsUpdated: vi.fn(),
    getSettings: () => ({}),
    getApiKey: (provider: string) => readerGetApiKey(provider),
  }),
}));

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
  const emptyInput = {
    messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false,
    transcriptionKey: false, companionTranscribe: false,
  };
  const cases = [
    ['messageMetadata', { ...emptyInput, messageMetadata: true }],
    ['nonDefaultSpeechSettings', { ...emptyInput, nonDefaultSpeechSettings: true }],
    ['retainedFailureAudio', { ...emptyInput, retainedFailureAudio: true }],
    ['transcriptionKey', { ...emptyInput, transcriptionKey: true }],
    ['companionTranscribe', { ...emptyInput, companionTranscribe: true }],
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
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
    });

    expect(installVoiceInput).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    expect(marker).toMatchObject({
      schemaVersion: 2,
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
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
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
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
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
    ['voiceCallHistory', { voiceCallHistory: true, nonDefaultRealtimeSettings: false, realtimeKey: false }],
    ['nonDefaultRealtimeSettings', { voiceCallHistory: false, nonDefaultRealtimeSettings: true, realtimeKey: false }],
    ['realtimeKey', { voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: true }],
  ] as const)('installs voice-live for independent legacy evidence: %s', async (_name, evidence) => {
    const dataDir = await makeDataDir();
    const installVoiceLive = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      installVoiceLive,
      evidenceReader: { read: async () => ({
        messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false,
        transcriptionKey: false, companionTranscribe: false,
      }) },
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
    const liveEvidenceReader = { read: vi.fn(async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: true, realtimeKey: false })) };
    const installVoiceLive = vi.fn();

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput: vi.fn(),
      installVoiceLive,
      evidenceReader: { read: async () => ({
        messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false,
        transcriptionKey: false, companionTranscribe: false,
      }) },
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
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
    });

    expect(inputEvidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceInput).not.toHaveBeenCalled();
    expect(installVoiceLive).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(markerFile, 'utf8'));
    expect(marker.voiceLive).toMatchObject({ status: 'completed', detail: 'migration:legacy-usage' });
  });
});

describe('schema 2 在两半都完成后才统一写（ai-review PR#1919 Nit）', () => {
  type MarkerShape = { schemaVersion?: number; updatedAt?: number; voiceInput?: { status?: string } };

  /** 轮询等第一跑把 voice-input 半边的中间标记写上盘（「进程死在两半之间」的现场）。 */
  async function waitForMarker(file: string, ready: (marker: MarkerShape) => boolean): Promise<MarkerShape> {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        const marker = JSON.parse(await fs.readFile(file, 'utf8')) as MarkerShape;
        if (ready(marker)) return marker;
      } catch { /* 还没写出来 */ }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('migration marker did not advance in time');
  }

  it('第一半完成后被杀：中间标记仍是 schema 1，重跑时 voice-live 仍被重判', async () => {
    const dataDir = await makeDataDir();
    // v1 现场还原：两半都「完成」，voice-live 被 v1 误卸（source=migration），标记停在 schema 1。
    await writeBundledHostCapabilityInstallState(dataDir, 'builtin.voice-input', 'removed', '1.0.0', 2, 'migration');
    await writeBundledHostCapabilityInstallState(dataDir, 'builtin.voice-live', 'removed', '1.0.0', 2, 'migration');
    const markerFile = path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json');
    await fs.mkdir(path.dirname(markerFile), { recursive: true });
    await fs.writeFile(markerFile, JSON.stringify({
      schemaVersion: 1,
      voiceInput: { status: 'completed', evidence: { messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false }, detail: 'no-legacy-usage' },
      voiceLive: { status: 'completed', evidence: { voiceCallHistory: false, nonDefaultRealtimeSettings: false }, detail: 'no-legacy-usage' },
      updatedAt: 1,
    }));
    const emptyInput = {
      messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false,
      transcriptionKey: false, companionTranscribe: false,
    };
    // 第一跑：voice-input 半边写完中间标记后，进程恰好死在 voice-live 读证据那一步（read 永不返回）。
    void runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.1',
      installVoiceInput: vi.fn(async () => undefined),
      installVoiceLive: vi.fn(),
      evidenceReader: { read: async () => emptyInput },
      liveEvidenceReader: { read: () => new Promise<never>(() => {}) },
    });
    const interrupted = await waitForMarker(markerFile, marker => marker.voiceInput?.status === 'completed' && (marker.updatedAt ?? 0) > 1);
    // 中间标记不许把 schema 升到 2——升了的话重跑按「voice-live 已纠正过」跳过重判，误卸就永远漏掉
    expect(interrupted.schemaVersion).toBe(1);
    // 重跑：voice-live 仍被重判，证据说有历史通话 → 补装；两半落定后 schema 才统一升 2
    const installVoiceLive = vi.fn(async () => undefined);
    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.1',
      installVoiceInput: vi.fn(async () => undefined),
      installVoiceLive,
      evidenceReader: { read: async () => emptyInput },
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
    });
    expect(installVoiceLive).toHaveBeenCalledOnce();
    const settled = JSON.parse(await fs.readFile(markerFile, 'utf8')) as MarkerShape;
    expect(settled.schemaVersion).toBe(2);
  });
});

describe('voice-input 真实读取器路径（非只注入 evidenceReader）', () => {
  /** 不传 evidenceReader → 默认生产读取器真跑；观察点是结果 marker 的 evidence。 */
  async function runWithProductionInputReader() {
    const dataDir = await makeDataDir();
    const installVoiceInput = vi.fn(async () => undefined);
    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.0',
      installVoiceInput,
      installVoiceLive: vi.fn(),
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
    });
    const marker = JSON.parse(await fs.readFile(
      path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'),
      'utf8',
    ));
    return { installVoiceInput, marker };
  }

  /** os.tmpdir 钉到空目录：retainedFailureAudio 不随机上机器状态。 */
  async function isolateTmpdir(): Promise<void> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'neo-voice-reader-'));
    dataDirs.push(root);
    vi.spyOn(os, 'tmpdir').mockReturnValue(root);
  }

  it('读 workbench.voiceInput，不把顶层 metadata.voiceInput 当证据', async () => {
    await isolateTmpdir();
    try {
      readerDb.messages = [
        { metadata: { voiceInput: { source: 'dictation' } } },
        { metadata: undefined },
      ];
      readerGetApiKey.mockReturnValue(undefined);
      const withoutUsage = await runWithProductionInputReader();
      expect(withoutUsage.marker.voiceInput).toMatchObject({
        status: 'completed',
        evidence: {
          messageMetadata: false,
          nonDefaultSpeechSettings: false,
          retainedFailureAudio: false,
          transcriptionKey: false,
          companionTranscribe: false,
        },
        detail: 'no-legacy-usage',
      });
      expect(withoutUsage.installVoiceInput).not.toHaveBeenCalled();

      readerDb.messages = [{ metadata: { workbench: { voiceInput: { source: 'dictation' } } } }];
      const withUsage = await runWithProductionInputReader();
      expect(withUsage.marker.voiceInput.evidence.messageMetadata).toBe(true);
      expect(withUsage.marker.voiceInput.detail).toBe('migration:legacy-usage');
      expect(withUsage.installVoiceInput).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('Groq / DashScope 密钥算作使用证据', async () => {
    await isolateTmpdir();
    try {
      readerDb.messages = [];
      readerGetApiKey.mockImplementation(provider => provider === 'groq' ? 'gsk_x' : undefined);
      const groq = await runWithProductionInputReader();
      expect(groq.marker.voiceInput.evidence.transcriptionKey).toBe(true);
      expect(groq.installVoiceInput).toHaveBeenCalledOnce();

      readerGetApiKey.mockImplementation(provider => provider === 'dashscope' ? 'sk_x' : undefined);
      const dashscope = await runWithProductionInputReader();
      expect(dashscope.marker.voiceInput.evidence.transcriptionKey).toBe(true);
      expect(dashscope.installVoiceInput).toHaveBeenCalledOnce();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('v2 纠正误卸：source=migration 可重判，不覆盖手动卸载', () => {
  it('v1 把能力卸了（source=migration）且现在有用量 → 补装', async () => {
    const dataDir = await makeDataDir();
    await writeBundledHostCapabilityInstallState(dataDir, 'builtin.voice-input', 'removed', '1.0.0', 3, 'migration');
    await fs.mkdir(path.join(dataDir, 'capabilities'), { recursive: true });
    await fs.writeFile(path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'), JSON.stringify({
      schemaVersion: 1,
      voiceInput: {
        status: 'completed',
        evidence: { messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false },
        detail: 'no-legacy-usage',
      },
      voiceLive: { status: 'completed', evidence: { voiceCallHistory: false, nonDefaultRealtimeSettings: false }, detail: 'no-legacy-usage' },
      updatedAt: 1,
    }));
    const installVoiceInput = vi.fn(async () => undefined);

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.1',
      installVoiceInput,
      installVoiceLive: vi.fn(),
      evidenceReader: { read: async () => ({
        messageMetadata: false, nonDefaultSpeechSettings: false, retainedFailureAudio: false,
        transcriptionKey: true, companionTranscribe: false,
      }) },
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: false, nonDefaultRealtimeSettings: false, realtimeKey: false }) },
    });

    expect(installVoiceInput).toHaveBeenCalledOnce();
    const marker = JSON.parse(await fs.readFile(path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json'), 'utf8'));
    expect(marker.schemaVersion).toBe(2);
    expect(marker.voiceInput).toMatchObject({ status: 'completed', detail: 'migration:legacy-usage' });
  });

  it('用户手动卸载（source=user）即使有密钥也不补装', async () => {
    const dataDir = await makeDataDir();
    await writeBundledHostCapabilityInstallState(dataDir, 'builtin.voice-input', 'removed', '1.0.0', 9, 'user');
    const installVoiceInput = vi.fn();
    const evidenceReader = { read: vi.fn(async () => ({
      messageMetadata: true, nonDefaultSpeechSettings: true, retainedFailureAudio: true,
      transcriptionKey: true, companionTranscribe: true,
    })) };

    await runVoiceCapabilityMigrationV1({
      dataDir,
      version: '1.0.1',
      installVoiceInput,
      installVoiceLive: vi.fn(),
      evidenceReader,
      liveEvidenceReader: { read: async () => ({ voiceCallHistory: true, nonDefaultRealtimeSettings: true, realtimeKey: true }) },
    });

    expect(evidenceReader.read).not.toHaveBeenCalled();
    expect(installVoiceInput).not.toHaveBeenCalled();
    await expect(readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input')).resolves.toMatchObject({
      record: { state: 'removed', revision: 9, source: 'user' },
    });
  });
});
