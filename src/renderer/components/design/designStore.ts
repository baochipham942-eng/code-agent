// 设计工作区状态（Kun 借鉴）。表单 + 生成状态 + 预览 + 可折叠历史。
// 持久化表单/历史/当前选中（刷新可恢复）；预览内容与运行态不持久（transient）。
// 派发逻辑在 useDesignGeneration hook，本 store 只持有状态。
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DesignAspectRatio, DesignOutputType, DesignSurface } from './designTypes';
import type { DesignVersion } from './designFiles';
import { emptySpine, type VariantSpine } from './variantSpine';

export type DesignGenStatus = 'idle' | 'generating' | 'done' | 'error';

/** 一次设计生成的历史项。 */
export type DesignRun = {
  /** run 目录绝对路径，作为唯一 id。 */
  runDir: string;
  requirement: string;
  createdAt: number;
};

const HISTORY_MAX = 30;

interface DesignState {
  // 表单
  requirement: string;
  brandColor: string;
  tone: string[];
  surface: DesignSurface | null;
  outputType: DesignOutputType;
  /** 出图尺寸比例（仅图像产物用）。 */
  aspectRatio: DesignAspectRatio;
  // 历史 + 选中
  history: DesignRun[];
  /** 当前查看/生成的 run 目录。 */
  selectedRunDir: string | null;
  // 运行（不持久）
  status: DesignGenStatus;
  error: string | null;
  previewPath: string | null;
  previewHtml: string | null;
  // 版本快照（当前 run，不持久；磁盘是真理源）。viewingVersionPath 非空=正在看历史版本。
  versions: DesignVersion[];
  viewingVersionPath: string | null;
  // variant spine（当前 run，不持久；spine.json 是真理源）。持有版本的 pin/discard。
  spine: VariantSpine;

  // 表单 actions
  setRequirement: (v: string) => void;
  setBrandColor: (v: string) => void;
  toggleTone: (t: string) => void;
  setSurface: (s: DesignSurface | null) => void;
  setOutputType: (t: DesignOutputType) => void;
  setAspectRatio: (r: DesignAspectRatio) => void;

  // 历史 actions
  addHistory: (run: DesignRun) => void;
  selectRun: (runDir: string) => void;

  // 运行 actions
  startGenerating: (run: DesignRun) => void;
  /** 在现有 run 上续编：转生成态但保留当前预览（边改边刷，不闪空）。 */
  startEditing: (runDir: string) => void;
  setPreviewHtml: (html: string) => void;
  setDone: () => void;
  setError: (msg: string) => void;
  reset: () => void;

  // 版本 actions
  setVersions: (versions: DesignVersion[]) => void;
  setViewingVersion: (path: string | null) => void;
  setSpine: (spine: VariantSpine) => void;
}

export const useDesignStore = create<DesignState>()(
  persist(
    (set) => ({
      requirement: '',
      brandColor: '',
      tone: [],
      surface: null,
      outputType: 'prototype',
      aspectRatio: '1:1',
      history: [],
      selectedRunDir: null,
      status: 'idle',
      error: null,
      previewPath: null,
      previewHtml: null,
      versions: [],
      viewingVersionPath: null,
      spine: emptySpine(),

      setRequirement: (requirement) => set({ requirement }),
      setBrandColor: (brandColor) => set({ brandColor }),
      toggleTone: (t) =>
        set((s) => ({
          tone: s.tone.includes(t) ? s.tone.filter((x) => x !== t) : [...s.tone, t],
        })),
      setSurface: (surface) => set((s) => ({ surface: s.surface === surface ? null : surface })),
      setOutputType: (outputType) => set({ outputType }),
      setAspectRatio: (aspectRatio) => set({ aspectRatio }),

      addHistory: (run) =>
        set((s) => ({
          history: [run, ...s.history.filter((h) => h.runDir !== run.runDir)].slice(0, HISTORY_MAX),
        })),
      selectRun: (runDir) =>
        set({
          selectedRunDir: runDir,
          previewPath: runDir,
          previewHtml: null,
          status: 'idle',
          error: null,
          versions: [],
          viewingVersionPath: null,
          spine: emptySpine(),
        }),

      startGenerating: (run) =>
        set((s) => ({
          status: 'generating',
          error: null,
          previewPath: run.runDir,
          previewHtml: null,
          selectedRunDir: run.runDir,
          versions: [],
          viewingVersionPath: null,
          spine: emptySpine(),
          history: [run, ...s.history.filter((h) => h.runDir !== run.runDir)].slice(0, HISTORY_MAX),
        })),
      startEditing: (runDir) =>
        set({
          status: 'generating',
          error: null,
          previewPath: runDir,
          selectedRunDir: runDir,
          viewingVersionPath: null,
        }),
      setPreviewHtml: (previewHtml) => set({ previewHtml }),
      setDone: () => set({ status: 'done' }),
      setError: (error) => set({ status: 'error', error }),
      reset: () =>
        set({
          status: 'idle',
          error: null,
          previewPath: null,
          previewHtml: null,
          versions: [],
          viewingVersionPath: null,
          spine: emptySpine(),
        }),

      setVersions: (versions) => set({ versions }),
      setViewingVersion: (viewingVersionPath) => set({ viewingVersionPath }),
      setSpine: (spine) => set({ spine }),
    }),
    {
      name: 'code-agent-design',
      version: 1,
      // 只持久化表单/历史/选中；预览内容与运行态不持久。
      partialize: (s) => ({
        requirement: s.requirement,
        brandColor: s.brandColor,
        tone: s.tone,
        surface: s.surface,
        outputType: s.outputType,
        aspectRatio: s.aspectRatio,
        history: s.history,
        selectedRunDir: s.selectedRunDir,
      }),
    },
  ),
);
