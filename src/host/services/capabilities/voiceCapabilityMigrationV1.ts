import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../shared/contract/speech';
import { VOICE_LIVE_ENABLED_DEFAULT } from '../../../shared/contract/settings';
import { getConfigService } from '../core/configService';
import { getDatabase } from '../core/databaseService';
import {
  readBundledHostCapabilityInstallSnapshot,
  writeBundledHostCapabilityInstallState,
} from './bundledHostCapabilityInstallState';

/** v1 读错了 voiceInput 路径并漏掉密钥/手机用量；v2 用同一套写入路径重判误卸。 */
const VOICE_CAPABILITY_MIGRATION_SCHEMA = 2;

interface LegacyVoiceInputEvidence {
  messageMetadata: boolean;
  nonDefaultSpeechSettings: boolean;
  retainedFailureAudio: boolean;
  transcriptionKey: boolean;
  companionTranscribe: boolean;
}

interface LegacyVoiceLiveEvidence {
  voiceCallHistory: boolean;
  nonDefaultRealtimeSettings: boolean;
  realtimeKey: boolean;
}

interface EvidenceReader<T> {
  read(): Promise<T>;
}

type MigrationHalf<T> = {
  status: 'completed' | 'failed';
  evidence: T;
  detail: string;
};

interface VoiceCapabilityMigrationMarker {
  schemaVersion: 1 | 2;
  voiceInput: MigrationHalf<LegacyVoiceInputEvidence> | MigrationHalf<Omit<LegacyVoiceInputEvidence, 'transcriptionKey' | 'companionTranscribe'>>;
  voiceLive: MigrationHalf<LegacyVoiceLiveEvidence> | MigrationHalf<Omit<LegacyVoiceLiveEvidence, 'realtimeKey'>> | { status: 'pending' };
  updatedAt: number;
}

export interface RunVoiceCapabilityMigrationOptions {
  dataDir: string;
  version: string;
  liveVersion?: string;
  installVoiceInput: () => Promise<void>;
  installVoiceLive: () => Promise<void>;
  evidenceReader?: EvidenceReader<LegacyVoiceInputEvidence>;
  liveEvidenceReader?: EvidenceReader<LegacyVoiceLiveEvidence>;
}

const EMPTY_INPUT_EVIDENCE: LegacyVoiceInputEvidence = {
  messageMetadata: false,
  nonDefaultSpeechSettings: false,
  retainedFailureAudio: false,
  transcriptionKey: false,
  companionTranscribe: false,
};

const EMPTY_LIVE_EVIDENCE: LegacyVoiceLiveEvidence = {
  voiceCallHistory: false,
  nonDefaultRealtimeSettings: false,
  realtimeKey: false,
};

function markerPath(dataDir: string): string {
  return path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json');
}

async function readMarker(dataDir: string): Promise<VoiceCapabilityMigrationMarker | null> {
  try {
    const value = JSON.parse(await fs.readFile(markerPath(dataDir), 'utf8')) as VoiceCapabilityMigrationMarker;
    return (value.schemaVersion === 1 || value.schemaVersion === 2) && value.voiceInput?.status && value.voiceLive?.status ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function writeMarker(dataDir: string, marker: VoiceCapabilityMigrationMarker): Promise<void> {
  const target = markerPath(dataDir);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  try {
    await fs.writeFile(temp, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
    await fs.rename(temp, target);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => undefined);
  }
}

/** 写入端是 metadata.workbench.voiceInput（agentAppService.getMessageMetadata / web agent 路由）。顶层 metadata.voiceInput 是读错的路径。 */
export function messageHasVoiceInputUsage(metadata: unknown): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const workbench = (metadata as { workbench?: unknown }).workbench;
  return Boolean(workbench && typeof workbench === 'object' && (workbench as { voiceInput?: unknown }).voiceInput);
}

export function hasConfiguredTranscriptionKey(getKey: (provider: string) => string | undefined): boolean {
  return Boolean(getKey('groq') || getKey('dashscope') || getKey('qwen'));
}

function hasConfiguredRealtimeKey(getKey: (provider: string) => string | undefined): boolean {
  return Boolean(getKey('dashscope') || getKey('qwen'));
}

function hasLegacyVoiceInputMessage(): boolean {
  const database = getDatabase();
  if (!database.isReady) throw new Error('database unavailable while scanning legacy voice-input evidence');
  const sessionPageSize = 100;
  const messagePageSize = 500;
  for (let sessionOffset = 0; ; sessionOffset += sessionPageSize) {
    const sessions = database.listSessions(sessionPageSize, sessionOffset, true);
    for (const session of sessions) {
      for (let messageOffset = 0; ; messageOffset += messagePageSize) {
        const messages = database.getMessages(session.id, messagePageSize, messageOffset, { includeRewound: true });
        if (messages.some((message) => messageHasVoiceInputUsage(message.metadata))) {
          return true;
        }
        if (messages.length < messagePageSize) break;
      }
    }
    if (sessions.length < sessionPageSize) break;
  }
  return false;
}

function companionTranscribeUsed(): boolean {
  try {
    const database = getDatabase();
    if (!database.isReady) return false;
    return database.hasCompanionCommandAction('voice.transcribe');
  } catch {
    return false;
  }
}

const productionInputEvidenceReader: EvidenceReader<LegacyVoiceInputEvidence> = {
  async read() {
    const speech = { ...DEFAULT_SPEECH_INPUT_SETTINGS, ...(getConfigService().getSettings().speech ?? {}) };
    const retainedDir = path.join(os.tmpdir(), 'code-agent-speech-retained');
    const getKey = (provider: string) => {
      try {
        return getConfigService().getApiKey(provider as 'groq');
      } catch {
        return undefined;
      }
    };
    return {
      messageMetadata: hasLegacyVoiceInputMessage(),
      nonDefaultSpeechSettings: !isDeepStrictEqual(speech, DEFAULT_SPEECH_INPUT_SETTINGS),
      retainedFailureAudio: fsSync.existsSync(retainedDir)
        && fsSync.readdirSync(retainedDir).some((entry) => fsSync.statSync(path.join(retainedDir, entry)).isFile()),
      transcriptionKey: hasConfiguredTranscriptionKey(getKey),
      companionTranscribe: companionTranscribeUsed(),
    };
  },
};

const productionLiveEvidenceReader: EvidenceReader<LegacyVoiceLiveEvidence> = {
  async read() {
    const settings = getConfigService().getSettings();
    const live = settings.voice?.live ?? {};
    const database = getDatabase();
    if (!database.isReady) {
      throw new Error('database unavailable while scanning legacy voice-live evidence');
    }
    const getKey = (provider: string) => {
      try {
        return getConfigService().getApiKey(provider as 'dashscope');
      } catch {
        return undefined;
      }
    };
    return {
      voiceCallHistory: database.listVoiceCallSummaries(1).length > 0,
      nonDefaultRealtimeSettings: !isDeepStrictEqual(live, { enabled: VOICE_LIVE_ENABLED_DEFAULT })
        || settings.voice?.turnDetection !== undefined,
      realtimeKey: hasConfiguredRealtimeKey(getKey),
    };
  },
};

function explicitlyRemoved(source: string | undefined, state: string | undefined): boolean {
  return state === 'removed' && (source === 'user' || source === undefined);
}

function migrationRemoved(source: string | undefined, state: string | undefined): boolean {
  return state === 'removed' && (source === 'migration' || source === 'migration-failed');
}

function shouldReconsiderHalf(
  half: { status: string },
  snapshot: { record?: { source?: string; state?: string } | null },
  schemaVersion: number,
): boolean {
  if (explicitlyRemoved(snapshot.record?.source, snapshot.record?.state)) return false;
  if (half.status !== 'completed') return true;
  return schemaVersion < VOICE_CAPABILITY_MIGRATION_SCHEMA && migrationRemoved(snapshot.record?.source, snapshot.record?.state);
}

export async function runVoiceCapabilityMigrationV1({
  dataDir,
  version,
  liveVersion = version,
  installVoiceInput,
  installVoiceLive,
  evidenceReader = productionInputEvidenceReader,
  liveEvidenceReader = productionLiveEvidenceReader,
}: RunVoiceCapabilityMigrationOptions): Promise<void> {
  const existing = await readMarker(dataDir);
  let marker: VoiceCapabilityMigrationMarker = existing ?? {
    schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
    voiceInput: { status: 'failed', evidence: EMPTY_INPUT_EVIDENCE, detail: 'pending' },
    voiceLive: { status: 'pending' },
    updatedAt: Date.now(),
  };
  const schemaVersion = marker.schemaVersion === 2 ? 2 : 1;

  const inputSnapshot = await readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input');
  if (shouldReconsiderHalf(marker.voiceInput, inputSnapshot, schemaVersion)) {
    if (explicitlyRemoved(inputSnapshot.record?.source, inputSnapshot.record?.state)) {
      marker = {
        ...marker,
        schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
        voiceInput: { status: 'completed', evidence: EMPTY_INPUT_EVIDENCE, detail: 'explicit-removal-preserved' },
        updatedAt: Date.now(),
      };
    } else {
      let evidence = EMPTY_INPUT_EVIDENCE;
      try {
        evidence = await evidenceReader.read();
        const hasUsage = Object.values(evidence).some(Boolean);
        if (hasUsage) await installVoiceInput();
        else {
          await writeBundledHostCapabilityInstallState(
            dataDir, 'builtin.voice-input', 'removed', version,
            (inputSnapshot.record?.revision ?? 0) + 1, 'migration',
          );
        }
        marker = {
          ...marker,
          schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
          voiceInput: { status: 'completed', evidence, detail: hasUsage ? 'migration:legacy-usage' : 'no-legacy-usage' },
          updatedAt: Date.now(),
        };
      } catch (error) {
        await writeBundledHostCapabilityInstallState(
          dataDir, 'builtin.voice-input', 'removed', version,
          (inputSnapshot.record?.revision ?? 0) + 1, 'migration-failed',
        );
        marker = {
          ...marker,
          schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
          voiceInput: { status: 'failed', evidence, detail: error instanceof Error ? error.message : String(error) },
          updatedAt: Date.now(),
        };
      }
    }
    await writeMarker(dataDir, marker);
  }

  const liveSnapshot = await readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-live');
  if (shouldReconsiderHalf(
    marker.voiceLive.status === 'pending' ? { status: 'pending' } : marker.voiceLive,
    liveSnapshot,
    schemaVersion,
  )) {
    if (explicitlyRemoved(liveSnapshot.record?.source, liveSnapshot.record?.state)) {
      marker = {
        ...marker,
        schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
        voiceLive: { status: 'completed', evidence: EMPTY_LIVE_EVIDENCE, detail: 'explicit-removal-preserved' },
        updatedAt: Date.now(),
      };
    } else {
      let evidence = EMPTY_LIVE_EVIDENCE;
      try {
        evidence = await liveEvidenceReader.read();
        const hasUsage = Object.values(evidence).some(Boolean);
        if (hasUsage) await installVoiceLive();
        else {
          await writeBundledHostCapabilityInstallState(
            dataDir, 'builtin.voice-live', 'removed', liveVersion,
            (liveSnapshot.record?.revision ?? 0) + 1, 'migration',
          );
        }
        marker = {
          ...marker,
          schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
          voiceLive: { status: 'completed', evidence, detail: hasUsage ? 'migration:legacy-usage' : 'no-legacy-usage' },
          updatedAt: Date.now(),
        };
      } catch (error) {
        await writeBundledHostCapabilityInstallState(
          dataDir, 'builtin.voice-live', 'removed', liveVersion,
          (liveSnapshot.record?.revision ?? 0) + 1, 'migration-failed',
        );
        marker = {
          ...marker,
          schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA,
          voiceLive: { status: 'failed', evidence, detail: error instanceof Error ? error.message : String(error) },
          updatedAt: Date.now(),
        };
      }
    }
    await writeMarker(dataDir, marker);
  }

  if (marker.schemaVersion !== VOICE_CAPABILITY_MIGRATION_SCHEMA) {
    marker = { ...marker, schemaVersion: VOICE_CAPABILITY_MIGRATION_SCHEMA, updatedAt: Date.now() };
    await writeMarker(dataDir, marker);
  }
}
