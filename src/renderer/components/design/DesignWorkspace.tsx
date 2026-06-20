// 设计工作区（Kun 借鉴：设计 tab）。左侧 composer（历史 + 需求 + 设计上下文 + 产物
// 类型）+ 右侧预览。v1 把「交互原型」整条闭环打通；设计稿/信息图占位标「即将」。
// 所有面向用户的文案统一走 i18n（t.design.*），避免中英混排。
import React, { useEffect, useRef, useState } from 'react';
import {
  Palette,
  Sparkles,
  Loader2,
  AlertCircle,
  History,
  ChevronRight,
  Monitor,
  Tablet,
  Smartphone,
  Wand2,
  Send,
  MousePointerClick,
  X,
  Clock,
  RotateCcw,
  ChevronDown,
  ExternalLink,
  Download,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { FullScreenPage } from '../features/shared/FullScreenPage';
import { WorkspaceModeSwitch } from './WorkspaceModeSwitch';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';
import { useDesignGeneration } from './useDesignGeneration';
import {
  readRunHtml,
  readWorkspaceFile,
  writeWorkspaceFile,
  findRunHtml,
  listVersions,
  openInDefaultApp,
  saveHtmlToDownloads,
  type DesignVersion,
} from './designFiles';
import { designDeviceWidth, prototypeExportName } from './designTypes';
import type { DesignOutputType, DesignSurface, PrototypeSelection } from './designTypes';
import { injectSelectionScript, parseProtoSelectMessage } from './designPreviewInject';
import { DESIGN_DEVICE_PRESETS, type DesignDeviceId } from '@shared/constants';

/** 加载某次历史生成的产物 + 版本列表到预览。 */
async function loadRun(runDir: string): Promise<void> {
  useDesignStore.getState().selectRun(runDir);
  const html = await readRunHtml(runDir);
  // 期间未被其它操作取代才写入。
  if (html && useDesignStore.getState().previewPath === runDir) {
    useDesignStore.getState().setPreviewHtml(html);
  }
  const versions = await listVersions(runDir);
  if (useDesignStore.getState().previewPath === runDir) {
    useDesignStore.getState().setVersions(versions);
  }
}

const HistorySection: React.FC = () => {
  const { t } = useI18n();
  const history = useDesignStore((s) => s.history);
  const selectedRunDir = useDesignStore((s) => s.selectedRunDir);
  const [open, setOpen] = useState(false);

  if (history.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <ChevronRight className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        <History className="h-3.5 w-3.5" />
        <span>
          {t.design.historyTitle}（{history.length}）
        </span>
      </button>
      {open && (
        <div className="flex flex-col gap-0.5 pl-1">
          {history.map((run) => (
            <button
              key={run.runDir}
              type="button"
              onClick={() => void loadRun(run.runDir)}
              title={run.requirement}
              className={`truncate rounded-md px-2 py-1 text-left text-xs transition-colors ${
                selectedRunDir === run.runDir
                  ? 'bg-white/[0.08] text-zinc-100'
                  : 'text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
              }`}
            >
              {run.requirement || run.runDir.split('/').pop()}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const Composer: React.FC = () => {
  const { t } = useI18n();
  const s = useDesignStore();
  const { generate } = useDesignGeneration();
  const generating = s.status === 'generating';

  const outputTypes: Array<{ type: DesignOutputType; label: string; soon?: boolean }> = [
    { type: 'prototype', label: t.design.outputPrototype },
    { type: 'mockup', label: t.design.outputMockup, soon: true },
    { type: 'infographic', label: t.design.outputInfographic, soon: true },
  ];
  const surfaces: Array<{ value: DesignSurface; label: string }> = [
    { value: 'brand', label: t.design.surfaceBrand },
    { value: 'product', label: t.design.surfaceProduct },
  ];

  return (
    <div className="flex flex-col gap-5 w-80 shrink-0 border-r border-white/[0.06] p-4 overflow-y-auto">
      <HistorySection />

      {/* 产物类型 */}
      <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
        {outputTypes.map(({ type, label, soon }) => (
          <button
            key={type}
            type="button"
            onClick={() => s.setOutputType(type)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
              s.outputType === type
                ? 'bg-white/[0.10] text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {label}
            {soon && <span className="ml-1 text-[10px] text-zinc-500">{t.design.soon}</span>}
          </button>
        ))}
      </div>

      {/* 需求 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.requirementLabel}</span>
        <textarea
          value={s.requirement}
          onChange={(e) => s.setRequirement(e.target.value)}
          placeholder={t.design.requirementPlaceholder}
          rows={5}
          className="resize-none rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
        />
      </label>

      {/* 品牌色 */}
      <label className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.brandColorLabel}</span>
        <div className="flex items-center gap-2">
          <input
            type="color"
            value={s.brandColor || '#3b82f6'}
            onChange={(e) => s.setBrandColor(e.target.value)}
            className="h-8 w-10 cursor-pointer rounded border border-white/[0.08] bg-transparent"
          />
          <input
            type="text"
            value={s.brandColor}
            onChange={(e) => s.setBrandColor(e.target.value)}
            placeholder={t.design.brandColorPlaceholder}
            className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none"
          />
        </div>
      </label>

      {/* 语气 */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.toneLabel}</span>
        <div className="flex flex-wrap gap-1.5">
          {t.design.tones.map((tone) => (
            <button
              key={tone}
              type="button"
              onClick={() => s.toggleTone(tone)}
              className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                s.tone.includes(tone)
                  ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                  : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tone}
            </button>
          ))}
        </div>
      </div>

      {/* Surface */}
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-400">{t.design.surfaceLabel}</span>
        <div className="flex gap-1 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
          {surfaces.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              onClick={() => s.setSurface(value)}
              className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${
                s.surface === value
                  ? 'bg-white/[0.10] text-zinc-100'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* 生成 */}
      <button
        type="button"
        onClick={() => void generate()}
        disabled={generating}
        className="mt-1 inline-flex items-center justify-center gap-2 rounded-lg bg-fuchsia-500/90 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-50"
      >
        {generating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
        {generating ? t.design.generating : t.design.generate}
      </button>

      {s.error && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{s.error}</span>
        </div>
      )}
    </div>
  );
};

const DEVICE_ICONS: Record<DesignDeviceId, React.ReactNode> = {
  desktop: <Monitor className="h-3.5 w-3.5" />,
  tablet: <Tablet className="h-3.5 w-3.5" />,
  mobile: <Smartphone className="h-3.5 w-3.5" />,
};

const DeviceSwitch: React.FC<{ device: DesignDeviceId; onChange: (d: DesignDeviceId) => void }> = ({
  device,
  onChange,
}) => {
  const { t } = useI18n();
  const labels: Record<DesignDeviceId, string> = {
    desktop: t.design.deviceDesktop,
    tablet: t.design.deviceTablet,
    mobile: t.design.deviceMobile,
  };
  return (
    <div className="inline-flex items-center gap-0.5 rounded-lg border border-white/[0.08] bg-white/[0.02] p-0.5">
      {DESIGN_DEVICE_PRESETS.map(({ id }) => {
        const active = device === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            aria-pressed={active}
            title={labels[id]}
            className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs transition-colors ${
              active ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
            }`}
          >
            {DEVICE_ICONS[id]}
            <span>{labels[id]}</span>
          </button>
        );
      })}
    </div>
  );
};

/**
 * 续编输入条：在当前预览的原型上继续局部修改（backlog #3）。
 * selection 由 PreviewPane 圈选传入（backlog #2）：有选中时附目标元素定位并显示 chip。
 */
const ContinueEditBar: React.FC<{
  selection: PrototypeSelection | null;
  onClearSelection: () => void;
}> = ({ selection, onClearSelection }) => {
  const { t } = useI18n();
  const { continueEdit } = useDesignGeneration();
  const generating = useDesignStore((s) => s.status === 'generating');
  const [text, setText] = useState('');

  const submit = async (): Promise<void> => {
    const v = text.trim();
    if (!v || generating) return;
    setText('');
    const sel = selection ?? undefined;
    onClearSelection();
    await continueEdit(v, sel);
  };

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-t border-white/[0.06] px-3 py-2">
      {selection && (
        <div className="flex items-center gap-1.5 self-start rounded-md border border-fuchsia-400/30 bg-fuchsia-400/10 px-2 py-0.5 text-[11px] text-fuchsia-200">
          <MousePointerClick className="h-3 w-3" />
          <span>{t.design.selectionTarget}</span>
          <span className="font-mono text-fuchsia-300">&lt;{selection.tag}&gt;</span>
          {selection.text && <span className="max-w-[160px] truncate text-zinc-300">{selection.text}</span>}
          <button type="button" onClick={onClearSelection} className="ml-0.5 text-fuchsia-300 hover:text-fuchsia-100">
            <X className="h-3 w-3" />
          </button>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Wand2 className="h-3.5 w-3.5 shrink-0 text-fuchsia-300" />
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void submit();
            }
          }}
          placeholder={t.design.continueEditPlaceholder}
          disabled={generating}
          className="flex-1 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-white/[0.2] focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={generating || !text.trim()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-fuchsia-500/90 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-fuchsia-500 disabled:opacity-40"
        >
          <Send className="h-3.5 w-3.5" />
          {t.design.continueEditSend}
        </button>
      </div>
    </div>
  );
};

const formatVersionTime = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

/** 版本下拉：列出当前原型的历史快照，选一个进入只读查看（backlog #4）。 */
const VersionControl: React.FC<{
  versions: DesignVersion[];
  viewingPath: string | null;
  onView: (v: DesignVersion) => void;
  onBackToLatest: () => void;
}> = ({ versions, viewingPath, onView, onBackToLatest }) => {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  if (versions.length === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.08] px-2 py-1 text-xs text-zinc-400 hover:text-zinc-200"
      >
        <Clock className="h-3.5 w-3.5" />
        <span>
          {t.design.versionsTitle}（{versions.length}）
        </span>
        <ChevronDown className="h-3 w-3" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-10 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-white/[0.1] bg-zinc-900 p-1 shadow-2xl">
          <button
            type="button"
            onClick={() => {
              onBackToLatest();
              setOpen(false);
            }}
            className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
              viewingPath === null ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
            }`}
          >
            <span className="text-emerald-300">●</span>
            {t.design.versionLatest}
          </button>
          {versions.map((v, i) => (
            <button
              key={v.path}
              type="button"
              onClick={() => {
                onView(v);
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-xs ${
                viewingPath === v.path ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-300 hover:bg-white/[0.04]'
              }`}
            >
              <span>v{versions.length - i}</span>
              <span className="text-zinc-500">{formatVersionTime(v.createdAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

/** 查看历史版本时的横幅：回滚到此 / 返回最新。 */
const ViewingBanner: React.FC<{ onRollback: () => void; onBackToLatest: () => void }> = ({
  onRollback,
  onBackToLatest,
}) => {
  const { t } = useI18n();
  return (
    <div className="flex shrink-0 items-center gap-2 border-t border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
      <Clock className="h-3.5 w-3.5 shrink-0" />
      <span>{t.design.versionViewing}</span>
      <button
        type="button"
        onClick={onRollback}
        className="ml-auto inline-flex items-center gap-1.5 rounded-md bg-amber-400/20 px-2.5 py-1 text-amber-100 hover:bg-amber-400/30"
      >
        <RotateCcw className="h-3.5 w-3.5" />
        {t.design.versionRollback}
      </button>
      <button
        type="button"
        onClick={onBackToLatest}
        className="rounded-md border border-amber-400/30 px-2.5 py-1 text-amber-200 hover:bg-amber-400/10"
      >
        {t.design.versionBackToLatest}
      </button>
    </div>
  );
};

const PreviewPane: React.FC = () => {
  const { t } = useI18n();
  const previewHtml = useDesignStore((s) => s.previewHtml);
  const status = useDesignStore((s) => s.status);
  const selectedRunDir = useDesignStore((s) => s.selectedRunDir);
  const versions = useDesignStore((s) => s.versions);
  const viewingVersionPath = useDesignStore((s) => s.viewingVersionPath);
  const [device, setDevice] = useState<DesignDeviceId>('desktop');
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<PrototypeSelection | null>(null);
  const [fullscreen, setFullscreen] = useState(false);
  const [exported, setExported] = useState(false);
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const viewing = viewingVersionPath !== null;

  // 全屏态下 Esc 退出。
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const handleOpenBrowser = async (): Promise<void> => {
    if (!selectedRunDir) return;
    const proto = (await findRunHtml(selectedRunDir)) ?? `${selectedRunDir}/prototype.html`;
    await openInDefaultApp(proto);
  };

  const handleExport = async (): Promise<void> => {
    if (!previewHtml) return;
    const saved = await saveHtmlToDownloads(prototypeExportName(Date.now()), previewHtml);
    if (saved) {
      setExported(true);
      setTimeout(() => setExported(false), 2000);
    }
  };

  const handleViewVersion = async (v: DesignVersion): Promise<void> => {
    const html = await readWorkspaceFile(v.path);
    if (html == null) return;
    setSelectMode(false);
    useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(v.path);
  };

  const handleBackToLatest = async (): Promise<void> => {
    if (!selectedRunDir) return;
    const html = await readRunHtml(selectedRunDir);
    if (html != null) useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(null);
  };

  const handleRollback = async (): Promise<void> => {
    if (!selectedRunDir || !viewingVersionPath) return;
    const html = await readWorkspaceFile(viewingVersionPath);
    if (html == null) return;
    const proto = (await findRunHtml(selectedRunDir)) ?? `${selectedRunDir}/prototype.html`;
    await writeWorkspaceFile(proto, html);
    useDesignStore.getState().setPreviewHtml(html);
    useDesignStore.getState().setViewingVersion(null);
  };

  // 监听 srcDoc 注入脚本发来的圈选消息：校验来自本 iframe + 形状合法，
  // 命中即设为选中目标并退出圈选模式（opaque origin 不可信，只认 source/type + contentWindow）。
  useEffect(() => {
    if (!selectMode) return;
    const handler = (e: MessageEvent): void => {
      if (e.source !== iframeRef.current?.contentWindow) return;
      const payload = parseProtoSelectMessage(e.data);
      if (!payload) return;
      setSelection(payload);
      setSelectMode(false);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [selectMode]);

  if (previewHtml) {
    const width = designDeviceWidth(device);
    const framed = device !== 'desktop';
    const srcDoc = injectSelectionScript(previewHtml, selectMode);
    return (
      <div
        className={
          fullscreen
            ? 'fixed inset-0 z-50 flex flex-col bg-zinc-950'
            : 'flex h-full w-full flex-col'
        }
      >
        <div className="relative flex h-10 shrink-0 items-center justify-center border-b border-white/[0.06] px-3">
          <div className="absolute left-3">
            <VersionControl
              versions={versions}
              viewingPath={viewingVersionPath}
              onView={(v) => void handleViewVersion(v)}
              onBackToLatest={() => void handleBackToLatest()}
            />
          </div>
          <DeviceSwitch device={device} onChange={setDevice} />
          <div className="absolute right-3 flex items-center gap-1">
            {!viewing && (
              <button
                type="button"
                onClick={() => setSelectMode((v) => !v)}
                aria-pressed={selectMode}
                title={selectMode ? t.design.selectActiveHint : t.design.selectToggle}
                className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-xs transition-colors ${
                  selectMode
                    ? 'border-fuchsia-400/40 bg-fuchsia-400/10 text-fuchsia-200'
                    : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
                }`}
              >
                <MousePointerClick className="h-3.5 w-3.5" />
                <span>{t.design.selectToggle}</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => void handleOpenBrowser()}
              title={t.design.actionOpenBrowser}
              className="rounded-md border border-white/[0.08] p-1.5 text-zinc-400 hover:text-zinc-200"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => void handleExport()}
              title={exported ? t.design.actionExported : t.design.actionExport}
              className={`rounded-md border p-1.5 transition-colors ${
                exported
                  ? 'border-emerald-400/40 bg-emerald-400/10 text-emerald-300'
                  : 'border-white/[0.08] text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Download className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setFullscreen((v) => !v)}
              title={fullscreen ? t.design.actionExitFullscreen : t.design.actionFullscreen}
              className="rounded-md border border-white/[0.08] p-1.5 text-zinc-400 hover:text-zinc-200"
            >
              {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
        <div
          className={`flex min-h-0 flex-1 justify-center overflow-auto ${
            framed ? 'bg-zinc-900 p-4' : ''
          }`}
        >
          <iframe
            ref={iframeRef}
            title="design-preview"
            srcDoc={srcDoc}
            style={{ width, maxWidth: '100%' }}
            className={`h-full border-0 bg-white ${framed ? 'rounded-lg shadow-2xl' : 'w-full'}`}
            sandbox="allow-scripts"
          />
        </div>
        {viewing ? (
          <ViewingBanner
            onRollback={() => void handleRollback()}
            onBackToLatest={() => void handleBackToLatest()}
          />
        ) : (
          <ContinueEditBar selection={selection} onClearSelection={() => setSelection(null)} />
        )}
      </div>
    );
  }
  return (
    <div className="flex h-full w-full items-center justify-center text-sm text-zinc-500">
      {status === 'generating' ? (
        <span className="inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> {t.design.previewGenerating}
        </span>
      ) : (
        t.design.previewEmpty
      )}
    </div>
  );
};

export const DesignWorkspace: React.FC = () => {
  const { t } = useI18n();

  // 刷新/重开恢复：若有持久化的选中生成且当前无预览内容，回读其产物。
  useEffect(() => {
    const st = useDesignStore.getState();
    if (st.selectedRunDir && !st.previewHtml && st.status === 'idle') {
      void loadRun(st.selectedRunDir);
    }
  }, []);

  return (
    <FullScreenPage testId="design-workspace">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
        <div className="flex items-center gap-2">
          <Palette className="h-4 w-4 text-fuchsia-300" />
          <span className="text-sm text-zinc-200">{t.design.title}</span>
        </div>
        <WorkspaceModeSwitch />
      </div>
      <div className="flex min-h-0 flex-1">
        <Composer />
        <div className="min-w-0 flex-1 bg-zinc-950">
          <PreviewPane />
        </div>
      </div>
    </FullScreenPage>
  );
};
