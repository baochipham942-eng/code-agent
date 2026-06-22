// 演示稿大纲（SlideData[]）的纯不可变操作——大纲编辑器 / 逐页预览 / 就地改字共用同一真源。
// 与主进程 SlideData 结构兼容（经 IPC 直传 generateSlidesDeck）；渲染端只编辑可见子集。

export interface SlideOutlineItem {
  title: string;
  subtitle?: string;
  points: string[];
  isTitle?: boolean;
  isEnd?: boolean;
  // 透传字段（编辑器不动，但生成时需保留）：
  layout?: string;
  code?: { language: string; content: string };
  table?: { headers: string[]; rows: string[][] };
}

/** 替换某页的部分字段（标题 / 副标题等）。 */
export function updateSlide(
  slides: SlideOutlineItem[],
  index: number,
  patch: Partial<SlideOutlineItem>,
): SlideOutlineItem[] {
  if (index < 0 || index >= slides.length) return slides;
  return slides.map((s, i) => (i === index ? { ...s, ...patch } : s));
}

/** 在 index 后插入一张空白内容页。 */
export function addSlideAfter(slides: SlideOutlineItem[], index: number): SlideOutlineItem[] {
  const blank: SlideOutlineItem = { title: '新页面', points: [''] };
  const at = Math.min(Math.max(index + 1, 0), slides.length);
  return [...slides.slice(0, at), blank, ...slides.slice(at)];
}

/** 删除某页（至少保留 1 页）。 */
export function removeSlide(slides: SlideOutlineItem[], index: number): SlideOutlineItem[] {
  if (slides.length <= 1 || index < 0 || index >= slides.length) return slides;
  return slides.filter((_, i) => i !== index);
}

/** 上移 / 下移某页（delta = -1 上，+1 下）。越界则原样返回。 */
export function moveSlide(
  slides: SlideOutlineItem[],
  index: number,
  delta: -1 | 1,
): SlideOutlineItem[] {
  const target = index + delta;
  if (index < 0 || index >= slides.length || target < 0 || target >= slides.length) return slides;
  const next = [...slides];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** 改某页某条要点文字。 */
export function updatePoint(
  slides: SlideOutlineItem[],
  slideIndex: number,
  pointIndex: number,
  text: string,
): SlideOutlineItem[] {
  if (slideIndex < 0 || slideIndex >= slides.length) return slides;
  return slides.map((s, i) => {
    if (i !== slideIndex) return s;
    if (pointIndex < 0 || pointIndex >= s.points.length) return s;
    return { ...s, points: s.points.map((p, j) => (j === pointIndex ? text : p)) };
  });
}

/** 给某页加一条空要点。 */
export function addPoint(slides: SlideOutlineItem[], slideIndex: number): SlideOutlineItem[] {
  if (slideIndex < 0 || slideIndex >= slides.length) return slides;
  return slides.map((s, i) => (i === slideIndex ? { ...s, points: [...s.points, ''] } : s));
}

/** 删某页某条要点。 */
export function removePoint(
  slides: SlideOutlineItem[],
  slideIndex: number,
  pointIndex: number,
): SlideOutlineItem[] {
  if (slideIndex < 0 || slideIndex >= slides.length) return slides;
  return slides.map((s, i) => {
    if (i !== slideIndex) return s;
    return { ...s, points: s.points.filter((_, j) => j !== pointIndex) };
  });
}

/** 生成前清洗：去掉全空白要点，trim 标题。空标题页给占位，避免排版异常。 */
export function sanitizeOutline(slides: SlideOutlineItem[]): SlideOutlineItem[] {
  return slides.map((s) => ({
    ...s,
    title: s.title.trim() || '（未命名）',
    points: s.points.map((p) => p.trim()).filter((p) => p.length > 0),
  }));
}
