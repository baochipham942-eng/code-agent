// ============================================================================
// PhotoLibraryTagger - 相册批量归档 service
// ============================================================================
//
// 编排 Photos.app connector + vision-tagger binary，做：
//   1. 从相册导出照片到临时目录
//   2. 批量调 vision-tagger（face / classify / all）
//   3. 人脸 cosine similarity 聚类
//   4. 主题分类聚合
//   5. 入库 memories 表（type='photo_archive'）
//   6. 清理临时目录
//
// photo-archive builtin skill 后续可调用此 service 而不是手写 bash 链。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { execFile } from 'child_process';
import { createLogger } from '../infra/logger';
import { getDatabase } from '../core/databaseService';
import { getConnectorRegistry } from '../../connectors/registry';
import type { ConnectorExecutionResult } from '../../connectors/base';

const logger = createLogger('PhotoLibraryTagger');

const BINARY_NAME = 'vision-tagger';
const DEFAULT_TAGGER_TIMEOUT_MS = 30_000;

let cachedBinaryPath: string | null = null;

function findVisionTaggerBinary(): string | null {
  if (cachedBinaryPath && fs.existsSync(cachedBinaryPath)) return cachedBinaryPath;

  const candidates: string[] = [];
  candidates.push(path.join(__dirname, '..', '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', '..', 'scripts', BINARY_NAME));
  candidates.push(path.join(__dirname, '..', 'scripts', BINARY_NAME));
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        cachedBinaryPath = candidate;
        return candidate;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export interface FaceObservation {
  index: number;
  confidence: number;
  boundingBox: { x: number; y: number; width: number; height: number };
  featurePrint?: string; // base64 of Float32 array
  featurePrintElementCount?: number;
  featurePrintElementType?: string;
}

export interface ClassificationObservation {
  identifier: string;
  confidence: number;
}

export interface PhotoTaggerOutput {
  ok: boolean;
  path: string;
  error?: string;
  imageSize?: { width: number; height: number };
  mode: string;
  faces?: FaceObservation[];
  faceCount?: number;
  classifications?: ClassificationObservation[];
}

interface RunTaggerArgs {
  binary: string;
  photoPath: string;
  mode: 'face' | 'classify' | 'all';
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

function runTagger(args: RunTaggerArgs): Promise<PhotoTaggerOutput> {
  return new Promise((resolve) => {
    const cli = ['--photo', args.photoPath, '--mode', args.mode];
    const child = execFile(
      args.binary,
      cli,
      {
        timeout: args.timeoutMs ?? DEFAULT_TAGGER_TIMEOUT_MS,
        maxBuffer: 32 * 1024 * 1024,
        encoding: 'utf-8',
      },
      (err, stdout, stderr) => {
        if (args.abortSignal?.aborted) {
          resolve({ ok: false, path: args.photoPath, mode: args.mode, error: 'aborted' });
          return;
        }
        if (err) {
          try {
            const parsed = JSON.parse(stdout) as PhotoTaggerOutput;
            if (!parsed.ok) {
              resolve(parsed);
              return;
            }
          } catch {
            // not JSON
          }
          resolve({
            ok: false,
            path: args.photoPath,
            mode: args.mode,
            error: (stderr || '').trim() || err.message,
          });
          return;
        }
        try {
          resolve(JSON.parse(stdout) as PhotoTaggerOutput);
        } catch (parseErr) {
          resolve({
            ok: false,
            path: args.photoPath,
            mode: args.mode,
            error: 'invalid_json_output: ' +
              (parseErr instanceof Error ? parseErr.message : String(parseErr)),
          });
        }
      },
    );

    if (args.abortSignal?.aborted) {
      child.kill('SIGTERM');
      return;
    }
    if (args.abortSignal) {
      const onAbort = () => child.kill('SIGTERM');
      args.abortSignal.addEventListener('abort', onAbort, { once: true });
      child.once('close', () => args.abortSignal?.removeEventListener('abort', onAbort));
    }
  });
}

// ----------------------------------------------------------------------------
// Cosine similarity 聚类
// ----------------------------------------------------------------------------

function decodeFeaturePrint(base64: string): Float32Array {
  const buf = Buffer.from(base64, 'base64');
  // 用底层 buffer 创建 Float32Array view（避免拷贝）
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface FaceRecord {
  photoPath: string;
  faceIndex: number;
  confidence: number;
  boundingBox: FaceObservation['boundingBox'];
  embedding: Float32Array;
}

interface FaceCluster {
  clusterId: string;
  faces: FaceRecord[];
}

/**
 * 简单连通分量聚类：对所有人脸两两比 cosine similarity，
 * 大于阈值视为同一人，并查集聚合。
 *
 * 对于 N < 500 张的常规相册够用；大相册（N > 5000）建议用近似最近邻
 * (HNSW / Annoy) 替换，作为后续优化项。
 */
function clusterFaces(records: FaceRecord[], threshold: number): FaceCluster[] {
  const n = records.length;
  if (n === 0) return [];

  // 并查集
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri !== rj) parent[ri] = rj;
  };

  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const sim = cosineSimilarity(records[i].embedding, records[j].embedding);
      if (sim >= threshold) union(i, j);
    }
  }

  const clusterMap = new Map<number, FaceRecord[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!clusterMap.has(root)) clusterMap.set(root, []);
    clusterMap.get(root)!.push(records[i]);
  }
  const clusters: FaceCluster[] = [];
  let idx = 1;
  for (const faces of clusterMap.values()) {
    clusters.push({
      clusterId: `person-${idx++}`,
      faces,
    });
  }
  // 按 cluster 大小降序
  clusters.sort((a, b) => b.faces.length - a.faces.length);
  // 重排 clusterId 让最大的 cluster 是 person-1
  return clusters.map((c, i) => ({ ...c, clusterId: `person-${i + 1}` }));
}

// ----------------------------------------------------------------------------
// 主入口
// ----------------------------------------------------------------------------

export interface ArchiveAlbumOptions {
  album?: string;
  uuids?: string[];
  mode?: 'face' | 'classify' | 'all';
  /** cosine similarity 聚类阈值，默认 0.6（经验值，可在 0.5-0.8 调） */
  faceSimilarityThreshold?: number;
  /** 单张照片 tagger 调用超时，默认 30s */
  taggerTimeoutMs?: number;
  /** 入库前的 sessionId，便于后续 memory_search 限定来源 */
  sessionId?: string;
  abortSignal?: AbortSignal;
  /** 是否在结束后删除导出的临时目录，默认 true */
  cleanupExport?: boolean;
}

export interface ArchiveAlbumReport {
  ok: boolean;
  error?: string;
  exportDir?: string;
  processed: number;
  failed: number;
  faceCount: number;
  clusters: Array<{ clusterId: string; size: number; samplePaths: string[] }>;
  topThemes: Array<{ identifier: string; count: number }>;
  memoryIds: string[];
}

export async function archiveAlbum(options: ArchiveAlbumOptions): Promise<ArchiveAlbumReport> {
  if (process.platform !== 'darwin') {
    return {
      ok: false,
      error: 'photoLibraryTagger 仅支持 macOS',
      processed: 0,
      failed: 0,
      faceCount: 0,
      clusters: [],
      topThemes: [],
      memoryIds: [],
    };
  }

  const binary = findVisionTaggerBinary();
  if (!binary) {
    return {
      ok: false,
      error: 'vision-tagger binary 未找到。请运行 scripts/build-vision-tagger.sh',
      processed: 0,
      failed: 0,
      faceCount: 0,
      clusters: [],
      topThemes: [],
      memoryIds: [],
    };
  }

  const mode = options.mode ?? 'all';
  const threshold = options.faceSimilarityThreshold ?? 0.6;
  const cleanup = options.cleanupExport !== false;

  // 1. 调 photos connector export_photos
  const registry = getConnectorRegistry();
  const photosConnector = registry.get('photos');
  if (!photosConnector) {
    return {
      ok: false,
      error: 'photos connector 未注册。请到 Settings → Connectors 启用 Photos',
      processed: 0,
      failed: 0,
      faceCount: 0,
      clusters: [],
      topThemes: [],
      memoryIds: [],
    };
  }

  let exportResult: ConnectorExecutionResult<{ exportDir: string; files: string[]; count: number }>;
  try {
    exportResult = (await photosConnector.execute('export_photos', {
      album: options.album,
      uuids: options.uuids,
    })) as ConnectorExecutionResult<{ exportDir: string; files: string[]; count: number }>;
  } catch (err) {
    return {
      ok: false,
      error: `导出照片失败: ${err instanceof Error ? err.message : String(err)}`,
      processed: 0,
      failed: 0,
      faceCount: 0,
      clusters: [],
      topThemes: [],
      memoryIds: [],
    };
  }

  const { exportDir, files } = exportResult.data;
  if (!files || files.length === 0) {
    return {
      ok: true,
      exportDir,
      processed: 0,
      failed: 0,
      faceCount: 0,
      clusters: [],
      topThemes: [],
      memoryIds: [],
    };
  }

  // 2. 批量调 vision-tagger（顺序避免 CPU/内存争抢）
  const taggerResults: PhotoTaggerOutput[] = [];
  for (const file of files) {
    if (options.abortSignal?.aborted) break;
    const r = await runTagger({
      binary,
      photoPath: file,
      mode,
      timeoutMs: options.taggerTimeoutMs,
      abortSignal: options.abortSignal,
    });
    taggerResults.push(r);
  }

  // 3. 收集人脸 + 聚类
  const faceRecords: FaceRecord[] = [];
  if (mode === 'face' || mode === 'all') {
    for (const r of taggerResults) {
      if (!r.ok || !r.faces) continue;
      for (const f of r.faces) {
        if (!f.featurePrint) continue;
        const emb = decodeFeaturePrint(f.featurePrint);
        if (emb.length === 0) continue;
        faceRecords.push({
          photoPath: r.path,
          faceIndex: f.index,
          confidence: f.confidence,
          boundingBox: f.boundingBox,
          embedding: emb,
        });
      }
    }
  }
  const clusters = clusterFaces(faceRecords, threshold);

  // 4. 主题分类聚合
  const themeCount = new Map<string, number>();
  if (mode === 'classify' || mode === 'all') {
    for (const r of taggerResults) {
      if (!r.ok || !r.classifications) continue;
      for (const cls of r.classifications) {
        themeCount.set(cls.identifier, (themeCount.get(cls.identifier) ?? 0) + 1);
      }
    }
  }
  const topThemes = Array.from(themeCount.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([identifier, count]) => ({ identifier, count }));

  // 5. 入库 memories 表（每张照片一条记录）
  const memoryIds: string[] = [];
  let failed = 0;
  try {
    const db = getDatabase();
    // photoPath → clusterId 反查
    const pathToCluster = new Map<string, string[]>();
    for (const c of clusters) {
      for (const f of c.faces) {
        if (!pathToCluster.has(f.photoPath)) pathToCluster.set(f.photoPath, []);
        pathToCluster.get(f.photoPath)!.push(c.clusterId);
      }
    }
    for (const r of taggerResults) {
      if (!r.ok) {
        failed++;
        continue;
      }
      const clusterIds = pathToCluster.get(r.path) ?? [];
      const topPhotoThemes = (r.classifications ?? [])
        .slice(0, 5)
        .map((c) => c.identifier)
        .join(', ');
      const summaryParts: string[] = [];
      if (clusterIds.length > 0) summaryParts.push(`人物: ${clusterIds.join(',')}`);
      if (topPhotoThemes) summaryParts.push(`主题: ${topPhotoThemes}`);
      summaryParts.push(`相册: ${options.album || '(uuid 列表)'}`);

      const memory = db.createMemory({
        type: 'photo_archive',
        category: clusterIds.length > 0 && topPhotoThemes
          ? 'mixed'
          : clusterIds.length > 0
            ? 'face_cluster'
            : 'theme_tag',
        content: JSON.stringify({
          photoPath: r.path,
          imageSize: r.imageSize,
          faces: r.faces,
          classifications: r.classifications,
          clusterIds,
        }),
        summary: summaryParts.join(' | '),
        source: 'auto_learned',
        sessionId: options.sessionId,
        confidence: (r.faces ?? []).length > 0
          ? (r.faces ?? []).reduce((s, f) => s + f.confidence, 0) / (r.faces ?? []).length
          : (r.classifications ?? [])[0]?.confidence ?? 0,
        metadata: {
          album: options.album,
          mode,
          photoPath: r.path,
          imageSize: r.imageSize,
          clusterIds,
          faceCount: (r.faces ?? []).length,
          topThemes: (r.classifications ?? []).slice(0, 5),
        },
      });
      memoryIds.push(memory.id);
    }
  } catch (err) {
    logger.error('archiveAlbum: failed to persist memory', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 6. 清理临时目录
  if (cleanup) {
    try {
      fs.rmSync(exportDir, { recursive: true, force: true });
    } catch (err) {
      logger.warn('archiveAlbum: cleanup export dir failed', {
        exportDir,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const processed = taggerResults.filter((r) => r.ok).length;
  return {
    ok: true,
    exportDir: cleanup ? undefined : exportDir,
    processed,
    failed,
    faceCount: faceRecords.length,
    clusters: clusters.map((c) => ({
      clusterId: c.clusterId,
      size: c.faces.length,
      samplePaths: c.faces.slice(0, 5).map((f) => f.photoPath),
    })),
    topThemes,
    memoryIds,
  };
}
