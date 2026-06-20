// 设计工作区状态（Kun 借鉴）。表单 + 生成状态 + 预览结果。
// 派发逻辑在 useDesignGeneration hook，本 store 只持有状态。
import { create } from 'zustand';
import type {
  DesignOutputType,
  DesignSurface,
} from './designTypes';

export type DesignGenStatus = 'idle' | 'generating' | 'done' | 'error';

interface DesignState {
  // 表单
  requirement: string;
  brandColor: string;
  tone: string[];
  surface: DesignSurface | null;
  outputType: DesignOutputType;
  // 运行
  status: DesignGenStatus;
  error: string | null;
  /** 当前生成的原型预留绝对路径。 */
  previewPath: string | null;
  /** 预览 iframe 的 srcDoc 内容（HTML 原型）。 */
  previewHtml: string | null;

  // 表单 actions
  setRequirement: (v: string) => void;
  setBrandColor: (v: string) => void;
  toggleTone: (t: string) => void;
  setSurface: (s: DesignSurface | null) => void;
  setOutputType: (t: DesignOutputType) => void;

  // 运行 actions
  startGenerating: (previewPath: string) => void;
  setPreviewHtml: (html: string) => void;
  setDone: () => void;
  setError: (msg: string) => void;
  reset: () => void;
}

export const useDesignStore = create<DesignState>((set) => ({
  requirement: '',
  brandColor: '',
  tone: [],
  surface: null,
  outputType: 'prototype',
  status: 'idle',
  error: null,
  previewPath: null,
  previewHtml: null,

  setRequirement: (requirement) => set({ requirement }),
  setBrandColor: (brandColor) => set({ brandColor }),
  toggleTone: (t) =>
    set((s) => ({
      tone: s.tone.includes(t) ? s.tone.filter((x) => x !== t) : [...s.tone, t],
    })),
  setSurface: (surface) => set((s) => ({ surface: s.surface === surface ? null : surface })),
  setOutputType: (outputType) => set({ outputType }),

  startGenerating: (previewPath) =>
    set({ status: 'generating', error: null, previewPath, previewHtml: null }),
  setPreviewHtml: (previewHtml) => set({ previewHtml }),
  setDone: () => set({ status: 'done' }),
  setError: (error) => set({ status: 'error', error }),
  reset: () => set({ status: 'idle', error: null, previewPath: null, previewHtml: null }),
}));
