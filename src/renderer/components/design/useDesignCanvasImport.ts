// 自由画布：导入用户自有图片（按钮选择 / 粘贴 / 拖拽）。
// 图片落 run 的 assets 后即普通画布节点，可被选中、圈选局部重绘（与生成图同构）。
import { useCallback } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { DESIGN_WORKSPACE } from '@shared/constants';
import { useI18n } from '../../hooks/useI18n';
import { useDesignCanvasStore } from './designCanvasStore';
import { ensureCanvasRun, saveCanvasDoc } from './designCanvasPersistence';
import { nextNodePlacement, type CanvasImageNode } from './designCanvasTypes';
import { loadImageDims } from './useDesignCanvasGeneration';

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function extFromType(type: string): string {
  const sub = (type.split('/')[1] || 'png').toLowerCase();
  return sub === 'jpeg' ? 'jpg' : sub.replace(/[^a-z0-9]/g, '') || 'png';
}

/** 导入选项：role='reference' 时落为参考图节点（生成前贴入，喂模型用，不进版本序号）。 */
export interface ImportOptions {
  role?: 'reference' | 'output';
}

export function useDesignCanvasImport(): {
  importFiles: (files: File[], options?: ImportOptions) => Promise<void>;
} {
  const { t } = useI18n();

  const importFiles = useCallback(async (files: File[], options?: ImportOptions) => {
    const images = files.filter((f) => f.type.startsWith('image/'));
    if (images.length === 0) return;

    const runDir = await ensureCanvasRun();
    if (!runDir) {
      useDesignCanvasStore.getState().setError(t.design.errResolveDir);
      return;
    }

    useDesignCanvasStore.getState().setError(null);
    useDesignCanvasStore.getState().setGenerating(true);
    try {
      // 逐张导入（用索引避免同毫秒 id 冲突）。
      for (let i = 0; i < images.length; i++) {
        const file = images[i];
        const dataUrl = await readFileAsDataUrl(file);
        const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/import-${Date.now()}-${i}.${extFromType(file.type)}`;
        const assetAbs = `${runDir}/${assetRel}`;
        const res = await window.domainAPI?.invoke<{ path: string }>(
          IPC_DOMAINS.WORKSPACE,
          'importDesignImage',
          { dataUrl, outputPath: assetAbs },
        );
        if (!res?.success) throw new Error(res?.error?.message || t.design.errDispatch);
        const { width, height } = await loadImageDims(dataUrl);
        const { x, y } = nextNodePlacement(
          useDesignCanvasStore.getState().nodes,
          DESIGN_WORKSPACE.CANVAS_NODE_GAP,
        );
        const node: CanvasImageNode = {
          id: `node-${Date.now()}-${i}`,
          src: assetRel,
          x,
          y,
          width,
          height,
          createdAt: Date.now(),
        };
        if (options?.role === 'reference') node.role = 'reference';
        useDesignCanvasStore.getState().addNode(node);
      }
      await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
      useDesignCanvasStore.getState().setGenerating(false);
    } catch (e) {
      useDesignCanvasStore.getState().setGenerating(false);
      useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
    }
  }, [t]);

  return { importFiles };
}
