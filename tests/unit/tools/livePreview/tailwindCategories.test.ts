// V2-B tailwindCategories 单测
// 重点：互斥规则正确（同 axis 替换、不同 axis 共存）+ 边缘 case
import { describe, it, expect } from 'vitest';
import {
  applyMutation,
  classifyClassName,
} from '../../../../src/main/tools/livePreview/tailwindCategories';

describe('classifyClassName', () => {
  it('双字符 padding axis 不被单字符 p 吞掉', () => {
    expect(classifyClassName('pt-4')).toBe('pt');
    expect(classifyClassName('px-8')).toBe('px');
    expect(classifyClassName('p-2')).toBe('p');
  });

  it('color 三个 target 分得清', () => {
    expect(classifyClassName('text-red-500')).toBe('text-color');
    expect(classifyClassName('bg-blue-600')).toBe('bg-color');
    expect(classifyClassName('border-zinc-200')).toBe('border-color');
  });

  it('text-{size} 不会被 text-{color} 错认', () => {
    expect(classifyClassName('text-xl')).toBe('text-size');
    expect(classifyClassName('text-base')).toBe('text-size');
    expect(classifyClassName('text-red-500')).toBe('text-color');
  });

  it('text-{align} 跟 text-{size}/{color} 区分', () => {
    expect(classifyClassName('text-left')).toBe('text-align');
    expect(classifyClassName('text-center')).toBe('text-align');
  });

  it('rounded 默认 / rounded-md 都识别', () => {
    expect(classifyClassName('rounded')).toBe('rounded');
    expect(classifyClassName('rounded-lg')).toBe('rounded');
    expect(classifyClassName('rounded-full')).toBe('rounded');
  });

  it('未知 class 返回 null（不报错）', () => {
    expect(classifyClassName('flex')).toBeNull();
    expect(classifyClassName('shadow-md')).toBeNull(); // 范围外
    expect(classifyClassName('container')).toBeNull();
  });
});

describe('applyMutation: spacing', () => {
  it('p-4 → p-8 替换且保留 px-2', () => {
    const res = applyMutation(['p-4', 'px-2', 'bg-blue-500'], { kind: 'spacing', axis: 'p', value: 8 });
    expect(res.finalClasses).toEqual(['p-8', 'px-2', 'bg-blue-500']);
    expect(res.removed).toEqual(['p-4']);
    expect(res.added).toEqual(['p-8']);
    expect(res.changed).toBe(true);
  });

  it('px-4 → px-8 不影响 p-2 也不影响 py-1', () => {
    const res = applyMutation(['p-2', 'px-4', 'py-1'], { kind: 'spacing', axis: 'px', value: 8 });
    expect(res.finalClasses).toEqual(['p-2', 'px-8', 'py-1']);
  });

  it('原本没有 p-{n} 时直接 append', () => {
    const res = applyMutation(['flex', 'gap-2'], { kind: 'spacing', axis: 'p', value: 4 });
    expect(res.finalClasses).toEqual(['flex', 'gap-2', 'p-4']);
    expect(res.removed).toEqual([]);
    expect(res.added).toEqual(['p-4']);
  });

  it('同值 noop 不报告 changed', () => {
    const res = applyMutation(['p-4', 'flex'], { kind: 'spacing', axis: 'p', value: 4 });
    expect(res.changed).toBe(false);
  });
});

describe('applyMutation: color', () => {
  it('bg-blue-500 → bg-red-600 同 target 内替换', () => {
    const res = applyMutation(['bg-blue-500', 'text-white'], { kind: 'color', target: 'bg', color: 'red', shade: 600 });
    expect(res.finalClasses).toEqual(['bg-red-600', 'text-white']);
  });

  it('改 bg 不影响 text-color', () => {
    const res = applyMutation(['bg-blue-500', 'text-red-500'], { kind: 'color', target: 'bg', color: 'green', shade: 400 });
    expect(res.finalClasses).toContain('text-red-500');
    expect(res.finalClasses).toContain('bg-green-400');
  });

  it('bg-white 没 shade 也能写', () => {
    const res = applyMutation(['bg-blue-500'], { kind: 'color', target: 'bg', color: 'white', shade: 500 });
    expect(res.added).toEqual(['bg-white']);
  });
});

describe('applyMutation: fontSize / radius / align', () => {
  it('text-xl → text-2xl 不影响 text-red-500 / text-center', () => {
    const res = applyMutation(['text-xl', 'text-red-500', 'text-center'], { kind: 'fontSize', size: '2xl' });
    expect(res.finalClasses).toContain('text-2xl');
    expect(res.finalClasses).toContain('text-red-500');
    expect(res.finalClasses).toContain('text-center');
    expect(res.finalClasses).not.toContain('text-xl');
  });

  it('rounded → rounded-lg', () => {
    const res = applyMutation(['rounded', 'p-4'], { kind: 'radius', size: 'lg' });
    expect(res.finalClasses).toEqual(['rounded-lg', 'p-4']);
  });

  it('text-left → text-center 不影响 text-color', () => {
    const res = applyMutation(['text-left', 'text-red-500'], { kind: 'align', axis: 'text', value: 'center' });
    expect(res.finalClasses).toEqual(['text-center', 'text-red-500']);
  });

  it('items-start → items-center', () => {
    const res = applyMutation(['flex', 'items-start'], { kind: 'align', axis: 'items', value: 'center' });
    expect(res.finalClasses).toEqual(['flex', 'items-center']);
  });
});

describe('applyMutation: 顺序保留', () => {
  it('替换时维持原 class 在视觉顺序里的位置', () => {
    const res = applyMutation(['flex', 'p-4', 'bg-blue-500', 'text-white'], { kind: 'spacing', axis: 'p', value: 12 });
    // p-4 在 idx 1，p-12 应该也在 idx 1
    expect(res.finalClasses).toEqual(['flex', 'p-12', 'bg-blue-500', 'text-white']);
  });
});
