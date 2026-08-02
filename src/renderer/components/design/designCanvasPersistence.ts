// 画布存档读写（renderer 侧，经 WORKSPACE domain IPC）。
// 存档落 run 目录下的 canvas.json；图片另落 assets/，存档只引相对路径。
import { IPC_DOMAINS } from '@shared/ipc';
import {
  deserializeCanvasDocWithReport,
  serializeCanvasDoc,
  emptyCanvasDoc,
  type DesignCanvasDoc,
} from './designCanvasTypes';
import { createLogger } from '../../utils/logger';
import { useDesignCanvasStore } from './designCanvasStore';
import { resolveDesignDir } from './designFiles';
import { saveDesignDocForCanvas } from './designDocPersistence';

const CANVAS_FILE = 'canvas.json';
const logger = createLogger('designCanvasPersistence');

/**
 * 确保画布有一个 run 目录：已有则复用；否则解析设计根目录、建 run-<ts>、载入空文档。
 * 生成与导入共用（同一画布持续铺多张产物）。失败返回 null。
 */
export async function ensureCanvasRun(): Promise<string | null> {
  const existing = useDesignCanvasStore.getState().runDir;
  if (existing) return existing;
  const baseDir = await resolveDesignDir();
  if (!baseDir) return null;
  const runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
  try {
    await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'createFolder', { dirPath: runDir });
  } catch {
    // Agent/写图时也会建父目录，这里失败不致命。
  }
  useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
  return runDir;
}

function canvasPath(runDir: string): string {
  return `${runDir.replace(/\/+$/, '')}/${CANVAS_FILE}`;
}

/** 读取某 run 的画布存档；不存在/破损都安全降级到空文档。 */
export async function loadCanvasDoc(runDir: string): Promise<DesignCanvasDoc> {
  try {
    const res = await window.domainAPI?.invoke<string>(IPC_DOMAINS.WORKSPACE, 'readFile', {
      filePath: canvasPath(runDir),
    });
    const loaded = deserializeCanvasDocWithReport(res?.success ? ((res.data as string) ?? '') : null);
    if (loaded.attributionDegraded) {
      logger.warn('canvas attribution validation failed; all entities marked user-touched', {
        event: 'canvas_attribution_degraded',
        runDir,
        filePath: canvasPath(runDir),
        reasons: loaded.reasons,
        nodeCount: loaded.doc.nodes.length,
        connectorCount: loaded.doc.connectors?.length ?? 0,
        shapeCount: loaded.doc.shapes?.length ?? 0,
      });
    }
    return loaded.doc;
  } catch (error) {
    logger.warn('canvas load failed; using empty document', {
      event: 'canvas_load_failed',
      runDir,
      filePath: canvasPath(runDir),
      error: error instanceof Error ? error.message : String(error),
    });
    return emptyCanvasDoc();
  }
}

/** 写入某 run 的画布存档。失败返回 false（调用方决定是否提示，不抛）。 */
export async function saveCanvasDoc(runDir: string, doc: DesignCanvasDoc): Promise<boolean> {
  try {
    const res = await window.domainAPI?.invoke(IPC_DOMAINS.WORKSPACE, 'writeFile', {
      filePath: canvasPath(runDir),
      content: serializeCanvasDoc(doc),
    });
    if (!res?.success) return false;
    return saveDesignDocForCanvas(runDir, doc);
  } catch {
    return false;
  }
}
