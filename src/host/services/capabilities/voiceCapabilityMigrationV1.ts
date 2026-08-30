import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_SPEECH_INPUT_SETTINGS } from '../../../shared/contract/speech';
import { getConfigService } from '../core/configService';
import { getDatabase } from '../core/databaseService';
import {
  readBundledHostCapabilityInstallSnapshot,
  writeBundledHostCapabilityInstallState,
} from './bundledHostCapabilityInstallState';

interface LegacyVoiceInputEvidence {
  messageMetadata: boolean;
  nonDefaultSpeechSettings: boolean;
  retainedFailureAudio: boolean;
}

interface LegacyVoiceInputEvidenceReader {
  read(): Promise<LegacyVoiceInputEvidence>;
}

interface VoiceCapabilityMigrationMarker {
  schemaVersion: 1;
  voiceInput: {
    status: 'completed' | 'failed';
    evidence: LegacyVoiceInputEvidence;
    detail: string;
  };
  voiceLive: { status: 'pending' };
  updatedAt: number;
}

export interface RunVoiceCapabilityMigrationOptions {
  dataDir: string;
  version: string;
  installVoiceInput: () => Promise<void>;
  evidenceReader?: LegacyVoiceInputEvidenceReader;
}

const EMPTY_EVIDENCE: LegacyVoiceInputEvidence = {
  messageMetadata: false,
  nonDefaultSpeechSettings: false,
  retainedFailureAudio: false,
};

function markerPath(dataDir: string): string {
  return path.join(dataDir, 'capabilities', 'voice-capability-migration-v1.json');
}

async function readMarker(dataDir: string): Promise<VoiceCapabilityMigrationMarker | null> {
  try {
    const value = JSON.parse(await fs.readFile(markerPath(dataDir), 'utf8')) as VoiceCapabilityMigrationMarker;
    return value.schemaVersion === 1 && value.voiceInput?.status ? value : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    // 损坏或旧形状 marker 视为尚未迁移，重新取证；不能让 voice-live 启动被连带阻断。
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

function hasLegacyVoiceInputMessage(): boolean {
  const database = getDatabase();
  const sessionPageSize = 100;
  const messagePageSize = 500;
  for (let sessionOffset = 0; ; sessionOffset += sessionPageSize) {
    const sessions = database.listSessions(sessionPageSize, sessionOffset, true);
    for (const session of sessions) {
      for (let messageOffset = 0; ; messageOffset += messagePageSize) {
        const messages = database.getMessages(session.id, messagePageSize, messageOffset, { includeRewound: true });
        if (messages.some((message) => Boolean((message.metadata as Record<string, unknown> | undefined)?.voiceInput))) {
          return true;
        }
        if (messages.length < messagePageSize) break;
      }
    }
    if (sessions.length < sessionPageSize) break;
  }
  return false;
}

const productionEvidenceReader: LegacyVoiceInputEvidenceReader = {
  async read() {
    const speech = {
      ...DEFAULT_SPEECH_INPUT_SETTINGS,
      ...(getConfigService().getSettings().speech ?? {}),
    };
    const retainedDir = path.join(os.tmpdir(), 'code-agent-speech-retained');
    return {
      messageMetadata: hasLegacyVoiceInputMessage(),
      nonDefaultSpeechSettings: !isDeepStrictEqual(speech, DEFAULT_SPEECH_INPUT_SETTINGS),
      retainedFailureAudio: fsSync.existsSync(retainedDir)
        && fsSync.readdirSync(retainedDir).some((entry) => fsSync.statSync(path.join(retainedDir, entry)).isFile()),
    };
  },
};

export async function runVoiceCapabilityMigrationV1({
  dataDir,
  version,
  installVoiceInput,
  evidenceReader = productionEvidenceReader,
}: RunVoiceCapabilityMigrationOptions): Promise<void> {
  const existingMarker = await readMarker(dataDir);
  if (existingMarker?.voiceInput.status === 'completed') return;

  const snapshot = await readBundledHostCapabilityInstallSnapshot(dataDir, 'builtin.voice-input');
  const explicitlyRemoved = snapshot.record?.state === 'removed'
    && (snapshot.record.source === 'user' || snapshot.record.source === undefined);
  if (explicitlyRemoved) {
    await writeMarker(dataDir, {
      schemaVersion: 1,
      voiceInput: { status: 'completed', evidence: EMPTY_EVIDENCE, detail: 'explicit-removal-preserved' },
      voiceLive: { status: 'pending' },
      updatedAt: Date.now(),
    });
    return;
  }

  let evidence = EMPTY_EVIDENCE;
  try {
    evidence = await evidenceReader.read();
    const hasUsage = Object.values(evidence).some(Boolean);
    if (hasUsage) {
      await installVoiceInput();
    } else {
      await writeBundledHostCapabilityInstallState(
        dataDir,
        'builtin.voice-input',
        'removed',
        version,
        (snapshot.record?.revision ?? 0) + 1,
        'migration',
      );
    }
    await writeMarker(dataDir, {
      schemaVersion: 1,
      voiceInput: {
        status: 'completed',
        evidence,
        detail: hasUsage ? 'migration:legacy-usage' : 'no-legacy-usage',
      },
      voiceLive: { status: 'pending' },
      updatedAt: Date.now(),
    });
  } catch (error) {
    await writeBundledHostCapabilityInstallState(
      dataDir,
      'builtin.voice-input',
      'removed',
      version,
      (snapshot.record?.revision ?? 0) + 1,
      'migration-failed',
    );
    await writeMarker(dataDir, {
      schemaVersion: 1,
      voiceInput: {
        status: 'failed',
        evidence,
        detail: error instanceof Error ? error.message : String(error),
      },
      voiceLive: { status: 'pending' },
      updatedAt: Date.now(),
    });
  }
}
