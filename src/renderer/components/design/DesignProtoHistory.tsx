// 交互原型（proto）的统一历史面板（P2：从预览区工具栏并入左侧 composer）。
// 与 canvas 历史（DesignCostHistory）同处左侧 composer、同视觉语言；点版本驱动右侧 iframe，
// 对比浮层仍在预览面渲染（共享 designStore 的 compareIds/comparing）。
// 版本动作（看版/回最新/设主版/淘汰）抽成 useProtoVersionActions，预览面与本面板共用。
import React, { useCallback, useMemo } from 'react';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { readRunHtml, readWorkspaceFile, type DesignVersion } from './designFiles';
import { saveProtoSpine } from './protoSpine';
import { activeVariants, pinVariant, discardVariant, type VariantSpine } from './variantSpine';
import { VersionControl, VersionComparePicker } from './DesignVersionUI';

/**
 * proto 版本动作（看版/回最新/设主版/淘汰），读 store 最新 spine 避免连续操作基于过期快照互相覆盖。
 * 预览面（对比浮层定稿）与左侧历史面板共用同一套动作，保证两侧行为一致。
 */
export function useProtoVersionActions(): {
  viewVersion: (v: DesignVersion) => Promise<void>;
  backToLatest: () => Promise<void>;
  pin: (id: string) => void;
  discard: (id: string) => void;
} {
  const persistSpine = useCallback(async (next: VariantSpine): Promise<void> => {
    const runDir = useDesignStore.getState().selectedRunDir;
    useDesignStore.getState().setSpine(next);
    if (runDir) await saveProtoSpine(runDir, next);
  }, []);

  const pin = useCallback(
    (id: string): void => {
      void persistSpine(pinVariant(useDesignStore.getState().spine, id));
    },
    [persistSpine],
  );

  const discard = useCallback(
    (id: string): void => {
      void persistSpine(discardVariant(useDesignStore.getState().spine, id));
      useDesignStore.getState().clearCompare();
    },
    [persistSpine],
  );

  const viewVersion = useCallback(async (v: DesignVersion): Promise<void> => {
    const html = await readWorkspaceFile(v.path);
    if (html == null) return;
    useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(v.path);
  }, []);

  const backToLatest = useCallback(async (): Promise<void> => {
    const runDir = useDesignStore.getState().selectedRunDir;
    if (!runDir) return;
    const html = await readRunHtml(runDir);
    if (html != null) useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(null);
  }, []);

  return { viewVersion, backToLatest, pin, discard };
}

/** 左侧 composer 的 proto 统一历史面板：版本下拉（看版/回最新）+ 版本对比选择（选版/定稿）。 */
export const DesignProtoHistory: React.FC = () => {
  const { t } = useI18n();
  const versions = useDesignStore((s) => s.versions);
  const viewingVersionPath = useDesignStore((s) => s.viewingVersionPath);
  const spine = useDesignStore((s) => s.spine);
  const compareIds = useDesignStore((s) => s.compareIds);
  const toggleCompareId = useDesignStore((s) => s.toggleCompareId);
  const setComparing = useDesignStore((s) => s.setComparing);
  const { viewVersion, backToLatest } = useProtoVersionActions();

  // 活跃 proto 版本（最新在前），供对比选择器；过滤已淘汰。
  const activeProtoVariants = useMemo(
    () =>
      activeVariants(spine)
        .filter((v) => v.kind === 'proto-html')
        .sort((a, b) => b.createdAt - a.createdAt),
    [spine],
  );

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      <span className="text-xs font-medium text-zinc-300">{t.design.historyPanelTitle}</span>
      {versions.length === 0 ? (
        <p className="text-[11px] leading-snug text-zinc-500">{t.design.historyPanelEmpty}</p>
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          <VersionControl
            versions={versions}
            viewingPath={viewingVersionPath}
            onView={(v) => void viewVersion(v)}
            onBackToLatest={() => void backToLatest()}
          />
          <VersionComparePicker
            variants={activeProtoVariants}
            picked={compareIds}
            onToggle={toggleCompareId}
            onCompare={() => setComparing(true)}
          />
        </div>
      )}
    </div>
  );
};
