// ============================================================================
// photo_archive (Vision Framework + Photos.app — native ToolModule)
//
// 包装 photoLibraryTagger.archiveAlbum，把"导出 → vision-tagger → 聚类 → 入库"
// 整条链路暴露成一个 agent 可直接调用的 tool。
// ============================================================================

import type {
  ToolHandler,
  ToolModule,
  ToolContext,
  CanUseToolFn,
  ToolProgressFn,
  ToolResult,
} from '../../../protocol/tools';
import { archiveAlbum } from '../../../services/desktop/photoLibraryTagger';
import { photoArchiveSchema as schema } from './photoArchive.schema';

interface PhotoArchiveOutput {
  processed: number;
  failed: number;
  faceCount: number;
  clusters: Array<{ clusterId: string; size: number; samplePaths: string[] }>;
  topThemes: Array<{ identifier: string; count: number }>;
  memoryIds: string[];
}

class PhotoArchiveHandler implements ToolHandler<Record<string, unknown>, PhotoArchiveOutput> {
  readonly schema = schema;

  async execute(
    args: Record<string, unknown>,
    ctx: ToolContext,
    _canUseTool: CanUseToolFn,
    onProgress?: ToolProgressFn,
  ): Promise<ToolResult<PhotoArchiveOutput>> {
    if (process.platform !== 'darwin') {
      return {
        ok: false,
        error: 'photo_archive 仅支持 macOS',
        code: 'PLATFORM_UNSUPPORTED',
      };
    }

    const album = typeof args.album === 'string' ? args.album : undefined;
    const uuidsRaw = args.uuids;
    const uuids = Array.isArray(uuidsRaw)
      ? uuidsRaw.filter((v): v is string => typeof v === 'string')
      : undefined;
    if (!album && (!uuids || uuids.length === 0)) {
      return {
        ok: false,
        error: '必须提供 album 或 uuids 之一',
        code: 'INVALID_ARGS',
      };
    }

    const modeRaw = args.mode;
    const mode = modeRaw === 'face' || modeRaw === 'classify' || modeRaw === 'all'
      ? modeRaw
      : 'all';

    const threshold = typeof args.faceSimilarityThreshold === 'number'
      ? args.faceSimilarityThreshold
      : undefined;
    const cleanupExport = args.cleanupExport !== false;

    onProgress?.({
      stage: 'running',
      detail: album ? `归档相册 "${album}"...` : `归档 ${uuids?.length ?? 0} 张照片...`,
    });

    const report = await archiveAlbum({
      album,
      uuids,
      mode,
      faceSimilarityThreshold: threshold,
      cleanupExport,
      sessionId: ctx.sessionId,
      abortSignal: ctx.abortSignal,
    });

    if (!report.ok) {
      return {
        ok: false,
        error: report.error ?? '相册归档失败',
        code: 'ARCHIVE_FAILED',
      };
    }

    onProgress?.({
      stage: 'completing',
      detail: `已处理 ${report.processed} 张照片，${report.faceCount} 个人脸 → ${report.clusters.length} 个聚类`,
    });

    return {
      ok: true,
      output: {
        processed: report.processed,
        failed: report.failed,
        faceCount: report.faceCount,
        clusters: report.clusters,
        topThemes: report.topThemes,
        memoryIds: report.memoryIds,
      },
      meta: {
        album,
        mode,
        memoryPersisted: report.memoryIds.length,
      },
    };
  }
}

export const photoArchiveModule: ToolModule<Record<string, unknown>, PhotoArchiveOutput> = {
  schema,
  createHandler() {
    return new PhotoArchiveHandler();
  },
};
