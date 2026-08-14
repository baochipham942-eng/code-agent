// ============================================================================
// 本人声纹持久层（N-L7-SPK 用途二：跨会话认本人）
//
// 合规承重（工单 §5，EDPB Guidelines 02/2021 ¶133）：
//   - 只存 embedding 向量 + 时间戳，**永不存原始音频**；
//   - 注册是显式动作（用户点头），没有「用着用着悄悄记住」；
//   - 清除 = 删除整个 voiceprint/ 目录，彻底且可验证；
//   - 保留期到期（长期未命中）自动删除——期限是写进设置页文案的用户可见数字；
//   - 本文件里的数据**永不上传、永不进诊断包、永不进日志/遥测**。
//
// ❌ 声纹绝不当认证用（不解锁/不授权/不「过阈即放行」）。这不是保守，是三层独立
// 证据支撑的边界：EDPB 02/2021 把 identification(1:N) 与 authentication(1:1) 正式
// 切开；HSBC Voice ID 被非同卵双胞胎骗过（2017）；Lloyds Voice ID 被 ElevenLabs
// 约 5 分钟样本克隆攻破（2023）。将来有人提「顺便做免密登录」，答案在这条注释里。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { getUserConfigDir } from '../../config/configPaths';
import {
  VOICEPRINT_DIR,
  VOICEPRINT_EMBEDDING_DIM,
  VOICEPRINT_MAX_OWNER_EMBEDDINGS,
  VOICEPRINT_PROFILE_FILE,
  VOICEPRINT_RETENTION_DAYS,
} from '../../../shared/constants/voice';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceprintStore');

interface OwnerEmbedding {
  vector: number[];
  createdAt: number;
}

interface OwnerProfileFile {
  version: 1;
  embeddings: OwnerEmbedding[];
  createdAt: number;
  lastMatchedAt: number;
}

export interface VoiceprintStatus {
  registered: boolean;
  createdAt?: number;
  lastMatchedAt?: number;
  sampleCount?: number;
}

export function getVoiceprintDir(): string {
  return path.join(getUserConfigDir(), VOICEPRINT_DIR);
}

function profilePath(): string {
  return path.join(getVoiceprintDir(), VOICEPRINT_PROFILE_FILE);
}

function readProfile(): OwnerProfileFile | null {
  try {
    const raw = fs.readFileSync(profilePath(), 'utf-8');
    const parsed = JSON.parse(raw) as OwnerProfileFile;
    if (parsed.version !== 1 || !Array.isArray(parsed.embeddings)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeProfile(profile: OwnerProfileFile): void {
  fs.mkdirSync(getVoiceprintDir(), { recursive: true });
  fs.writeFileSync(profilePath(), JSON.stringify(profile), 'utf-8');
}

/** 保留期守卫：长期未命中自动整目录删除。读取入口统一走这里，别绕过。 */
function loadWithRetentionGuard(now: number): OwnerProfileFile | null {
  const profile = readProfile();
  if (!profile) return null;
  const idleMs = now - Math.max(profile.lastMatchedAt, profile.createdAt);
  if (idleMs > VOICEPRINT_RETENTION_DAYS * 24 * 60 * 60 * 1_000) {
    logger.info('voiceprint expired by retention, clearing', { idleDays: Math.floor(idleMs / 86_400_000) });
    clearVoiceprint();
    return null;
  }
  return profile;
}

/** 通话建立时读入的比对集。未注册（默认态）= 空数组，上层一切照旧。 */
export function loadOwnerEmbeddings(now: number = Date.now()): Float32Array[] {
  const profile = loadWithRetentionGuard(now);
  if (!profile) return [];
  return profile.embeddings
    .filter((e) => Array.isArray(e.vector) && e.vector.length === VOICEPRINT_EMBEDDING_DIM)
    .map((e) => Float32Array.from(e.vector));
}

export function getVoiceprintStatus(now: number = Date.now()): VoiceprintStatus {
  const profile = loadWithRetentionGuard(now);
  if (!profile) return { registered: false };
  return {
    registered: true,
    createdAt: profile.createdAt,
    lastMatchedAt: profile.lastMatchedAt,
    sampleCount: profile.embeddings.length,
  };
}

/**
 * 显式注册（用户在设置页点「这是我」之后才会走到这里）。
 * 追加样本，超上限丢最旧——声纹随时间漂移，新样本更有代表性。
 */
export function registerOwnerEmbedding(vector: Float32Array, now: number = Date.now()): VoiceprintStatus {
  if (vector.length !== VOICEPRINT_EMBEDDING_DIM) {
    throw new Error(`voiceprint embedding dim mismatch: ${vector.length}`);
  }
  const existing = loadWithRetentionGuard(now);
  const embeddings = existing?.embeddings ?? [];
  embeddings.push({ vector: Array.from(vector), createdAt: now });
  while (embeddings.length > VOICEPRINT_MAX_OWNER_EMBEDDINGS) embeddings.shift();
  writeProfile({
    version: 1,
    embeddings,
    createdAt: existing?.createdAt ?? now,
    lastMatchedAt: now,
  });
  logger.info('voiceprint registered', { sampleCount: embeddings.length });
  return getVoiceprintStatus(now);
}

/** 认出本人后只回写时间戳（保留期以此计），不写向量。 */
export function touchOwnerMatched(now: number = Date.now()): void {
  const profile = readProfile();
  if (!profile) return;
  profile.lastMatchedAt = now;
  writeProfile(profile);
}

/** 一键清除：删整个目录。清除是彻底的（工单 §5）。 */
export function clearVoiceprint(): void {
  fs.rmSync(getVoiceprintDir(), { recursive: true, force: true });
  logger.info('voiceprint cleared');
}
