// 演示稿大纲纯操作单测：守护不可变、边界安全、增删改移与清洗。
import { describe, expect, it } from 'vitest';
import {
  updateSlide,
  addSlideAfter,
  removeSlide,
  moveSlide,
  updatePoint,
  addPoint,
  removePoint,
  sanitizeOutline,
  type SlideOutlineItem,
} from '../../../src/renderer/components/design/slidesOutlineOps';

const base = (): SlideOutlineItem[] => [
  { title: '封面', subtitle: '副标题', points: [], isTitle: true },
  { title: '第一节', points: ['要点一', '要点二'] },
  { title: '结尾', points: [], isEnd: true },
];

describe('slidesOutlineOps', () => {
  it('updateSlide：改标题不影响其他页，且不可变', () => {
    const s = base();
    const next = updateSlide(s, 1, { title: '改了' });
    expect(next[1].title).toBe('改了');
    expect(s[1].title).toBe('第一节'); // 原数组不变
    expect(next[0]).toBe(s[0]); // 未改页保持引用
  });

  it('updateSlide：越界 index 原样返回', () => {
    const s = base();
    expect(updateSlide(s, 9, { title: 'x' })).toBe(s);
  });

  it('addSlideAfter：在指定页后插入空白内容页', () => {
    const next = addSlideAfter(base(), 0);
    expect(next.length).toBe(4);
    expect(next[1].title).toBe('新页面');
    expect(next[1].isTitle).toBeUndefined();
  });

  it('removeSlide：删页；最后一页不可删空', () => {
    expect(removeSlide(base(), 1).length).toBe(2);
    expect(removeSlide([{ title: '唯一', points: [] }], 0).length).toBe(1);
  });

  it('moveSlide：上移下移；越界不动', () => {
    const s = base();
    expect(moveSlide(s, 1, -1)[0].title).toBe('第一节');
    expect(moveSlide(s, 0, -1)).toBe(s); // 首页上移越界
    expect(moveSlide(s, 2, 1)).toBe(s); // 末页下移越界
  });

  it('updatePoint / addPoint / removePoint', () => {
    let s = base();
    s = updatePoint(s, 1, 0, '改要点');
    expect(s[1].points[0]).toBe('改要点');
    s = addPoint(s, 1);
    expect(s[1].points.length).toBe(3);
    s = removePoint(s, 1, 2);
    expect(s[1].points.length).toBe(2);
  });

  it('sanitizeOutline：去空白要点 + trim 标题 + 空标题占位', () => {
    const dirty: SlideOutlineItem[] = [
      { title: '  有标题 ', points: ['  ok ', '   ', ''] },
      { title: '   ', points: [] },
    ];
    const clean = sanitizeOutline(dirty);
    expect(clean[0].title).toBe('有标题');
    expect(clean[0].points).toEqual(['ok']);
    expect(clean[1].title).toBe('（未命名）');
  });
});
