// 演示稿大纲工作区 store（厚版二期）：SlideData[] 作为单一真源，
// 大纲编辑器 / 逐页预览 / 就地改字都读写它。纯操作见 slidesOutlineOps.ts。
import { create } from 'zustand';
import {
  type SlideOutlineItem,
  updateSlide,
  addSlideAfter,
  removeSlide,
  moveSlide,
  updatePoint,
  addPoint,
  removePoint,
} from './slidesOutlineOps';

interface DesignSlidesState {
  outline: SlideOutlineItem[] | null;
  buildingOutline: boolean;
  generating: boolean;
  result: { filePath: string; slidesCount?: number } | null;
  error: string | null;

  setOutline: (slides: SlideOutlineItem[] | null) => void;
  setBuildingOutline: (v: boolean) => void;
  setGenerating: (v: boolean) => void;
  setResult: (r: { filePath: string; slidesCount?: number } | null) => void;
  setError: (e: string | null) => void;

  // 大纲编辑（包装纯操作，none-op 时引用不变避免重渲染）：
  editSlide: (index: number, patch: Partial<SlideOutlineItem>) => void;
  insertSlideAfter: (index: number) => void;
  deleteSlide: (index: number) => void;
  reorderSlide: (index: number, delta: -1 | 1) => void;
  editPoint: (slideIndex: number, pointIndex: number, text: string) => void;
  appendPoint: (slideIndex: number) => void;
  deletePoint: (slideIndex: number, pointIndex: number) => void;
}

export const useDesignSlidesStore = create<DesignSlidesState>((set, get) => ({
  outline: null,
  buildingOutline: false,
  generating: false,
  result: null,
  error: null,

  setOutline: (outline) => set({ outline }),
  setBuildingOutline: (buildingOutline) => set({ buildingOutline }),
  setGenerating: (generating) => set({ generating }),
  setResult: (result) => set({ result }),
  setError: (error) => set({ error }),

  editSlide: (index, patch) => {
    const cur = get().outline;
    if (cur) set({ outline: updateSlide(cur, index, patch) });
  },
  insertSlideAfter: (index) => {
    const cur = get().outline;
    if (cur) set({ outline: addSlideAfter(cur, index) });
  },
  deleteSlide: (index) => {
    const cur = get().outline;
    if (cur) set({ outline: removeSlide(cur, index) });
  },
  reorderSlide: (index, delta) => {
    const cur = get().outline;
    if (cur) set({ outline: moveSlide(cur, index, delta) });
  },
  editPoint: (slideIndex, pointIndex, text) => {
    const cur = get().outline;
    if (cur) set({ outline: updatePoint(cur, slideIndex, pointIndex, text) });
  },
  appendPoint: (slideIndex) => {
    const cur = get().outline;
    if (cur) set({ outline: addPoint(cur, slideIndex) });
  },
  deletePoint: (slideIndex, pointIndex) => {
    const cur = get().outline;
    if (cur) set({ outline: removePoint(cur, slideIndex, pointIndex) });
  },
}));
