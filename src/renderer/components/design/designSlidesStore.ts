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
  // 像素预览（增强 #2）：渲染后的每页 PNG 路径 + 状态。
  previewShots: string[] | null;
  previewing: boolean;
  previewMissing: boolean;

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
  previewShots: null,
  previewing: false,
  previewMissing: false,

  setOutline: (outline) => set({ outline }),
  setBuildingOutline: (buildingOutline) => set({ buildingOutline }),
  setGenerating: (generating) => set({ generating }),
  setResult: (result) => set({ result }),
  setError: (error) => set({ error }),

  // 任意大纲修改后清空像素预览（避免展示过时渲染）。
  editSlide: (index, patch) => applyEdit(get, set, (o) => updateSlide(o, index, patch)),
  insertSlideAfter: (index) => applyEdit(get, set, (o) => addSlideAfter(o, index)),
  deleteSlide: (index) => applyEdit(get, set, (o) => removeSlide(o, index)),
  reorderSlide: (index, delta) => applyEdit(get, set, (o) => moveSlide(o, index, delta)),
  editPoint: (slideIndex, pointIndex, text) =>
    applyEdit(get, set, (o) => updatePoint(o, slideIndex, pointIndex, text)),
  appendPoint: (slideIndex) => applyEdit(get, set, (o) => addPoint(o, slideIndex)),
  deletePoint: (slideIndex, pointIndex) =>
    applyEdit(get, set, (o) => removePoint(o, slideIndex, pointIndex)),
}));

type Get = () => DesignSlidesState;
type Set = (partial: Partial<DesignSlidesState>) => void;
function applyEdit(get: Get, set: Set, fn: (o: SlideOutlineItem[]) => SlideOutlineItem[]): void {
  const cur = get().outline;
  if (cur) set({ outline: fn(cur), previewShots: null });
}
