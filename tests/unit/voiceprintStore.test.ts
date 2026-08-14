import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  VOICEPRINT_DIR,
  VOICEPRINT_EMBEDDING_DIM,
  VOICEPRINT_MAX_OWNER_EMBEDDINGS,
  VOICEPRINT_PROFILE_FILE,
  VOICEPRINT_RETENTION_DAYS,
} from '../../src/shared/constants/voice';
import {
  clearVoiceprint,
  getVoiceprintStatus,
  loadOwnerEmbeddings,
  registerOwnerEmbedding,
  touchOwnerMatched,
} from '../../src/host/services/voice/voiceprintStore';

const DAY_MS = 24 * 60 * 60 * 1_000;

/** 按契约常量自己拼路径：不为了测试给内部 helper 开 export（knip 生产门会红）。 */
let dataDir = '';
function voiceprintDir(): string {
  return path.join(dataDir, VOICEPRINT_DIR);
}

function vec(fill: number): Float32Array {
  return new Float32Array(VOICEPRINT_EMBEDDING_DIM).fill(fill);
}

describe('voiceprintStore', () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceprint-store-'));
    dataDir = dir;
    prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    process.env.CODE_AGENT_DATA_DIR = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('默认态：未注册 = 空比对集 + registered:false + 不落任何文件（判据1）', () => {
    expect(loadOwnerEmbeddings()).toEqual([]);
    expect(getVoiceprintStatus()).toEqual({ registered: false });
    expect(fs.existsSync(voiceprintDir())).toBe(false);
  });

  it('注册后可读回，且落盘内容只有向量与时间戳（判据7：grep 不到音频）', () => {
    const now = 1_700_000_000_000;
    const status = registerOwnerEmbedding(vec(0.5), now);
    expect(status).toMatchObject({ registered: true, sampleCount: 1, createdAt: now });
    const loaded = loadOwnerEmbeddings(now);
    expect(loaded).toHaveLength(1);
    expect(loaded[0][0]).toBeCloseTo(0.5, 5);
    const raw = fs.readFileSync(path.join(voiceprintDir(), VOICEPRINT_PROFILE_FILE), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toEqual(['createdAt', 'embeddings', 'lastMatchedAt', 'version']);
    // 不存在任何音频形态的字段/编码（wav/pcm/base64 音频块）
    expect(raw).not.toMatch(/audio|pcm|wav|base64/i);
  });

  it('样本超上限丢最旧', () => {
    const now = 1_700_000_000_000;
    for (let i = 0; i <= VOICEPRINT_MAX_OWNER_EMBEDDINGS; i++) {
      registerOwnerEmbedding(vec(i + 1), now + i);
    }
    const loaded = loadOwnerEmbeddings(now);
    expect(loaded).toHaveLength(VOICEPRINT_MAX_OWNER_EMBEDDINGS);
    expect(loaded[0][0]).toBeCloseTo(2, 5); // 第一条(fill=1)被丢
  });

  it('维度不符直接拒绝', () => {
    expect(() => registerOwnerEmbedding(new Float32Array(10))).toThrow(/dim mismatch/);
  });

  it('一键清除后按未注册处理，目录整个消失（判据5）', () => {
    registerOwnerEmbedding(vec(0.1));
    clearVoiceprint();
    expect(getVoiceprintStatus()).toEqual({ registered: false });
    expect(fs.existsSync(voiceprintDir())).toBe(false);
  });

  it('保留期到且长期未命中 → 自动删除（工单 §4.2）', () => {
    const t0 = 1_700_000_000_000;
    registerOwnerEmbedding(vec(0.2), t0);
    const beforeExpiry = t0 + (VOICEPRINT_RETENTION_DAYS - 1) * DAY_MS;
    expect(loadOwnerEmbeddings(beforeExpiry)).toHaveLength(1);
    const afterExpiry = t0 + (VOICEPRINT_RETENTION_DAYS + 1) * DAY_MS;
    expect(loadOwnerEmbeddings(afterExpiry)).toEqual([]);
    expect(fs.existsSync(voiceprintDir())).toBe(false);
  });

  it('touchOwnerMatched 顺延保留期', () => {
    const t0 = 1_700_000_000_000;
    registerOwnerEmbedding(vec(0.3), t0);
    const mid = t0 + (VOICEPRINT_RETENTION_DAYS - 1) * DAY_MS;
    touchOwnerMatched(mid);
    const afterOriginalExpiry = t0 + (VOICEPRINT_RETENTION_DAYS + 1) * DAY_MS;
    expect(loadOwnerEmbeddings(afterOriginalExpiry)).toHaveLength(1);
  });

  it('损坏的档案文件按未注册处理（fail-open 不炸通话）', () => {
    fs.mkdirSync(voiceprintDir(), { recursive: true });
    fs.writeFileSync(path.join(voiceprintDir(), VOICEPRINT_PROFILE_FILE), 'not json');
    expect(loadOwnerEmbeddings()).toEqual([]);
    expect(getVoiceprintStatus()).toEqual({ registered: false });
  });
});
