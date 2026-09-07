// interpolate 的行为契约：与组件里原先手写的 `.replace('{x}', v)` 链逐字等价。
// 替换语义、$ 序列、只换第一个出现——这三条守住「换 helper 不改文案行为」的底线。
import { describe, expect, it } from 'vitest';
import { interpolate } from '../../../src/renderer/i18n/interpolate';

describe('interpolate', () => {
  it('单占位符：数字参数自动转字符串', () => {
    expect(interpolate('已挂载 {count} 项', { count: 3 })).toBe('已挂载 3 项');
  });

  it('多占位符：一次替换全部（与链式 .replace 等价）', () => {
    expect(
      interpolate('「{name}」检查失败：{error}（连续 {count} 次）', {
        name: 'db-ping',
        error: 'connection refused',
        count: 3,
      }),
    ).toBe('「db-ping」检查失败：connection refused（连续 3 次）');
  });

  it('同一占位符出现两次时只替换第一个——String#replace 的 string 重载语义，不悄悄升级成replaceAll', () => {
    expect(interpolate('{n} 和 {n}', { n: 1 })).toBe('1 和 {n}');
  });

  it('replacement 里的 $ 序列按 String#replace 语义处理（与手写行为一致）', () => {
    // $& 会展开为匹配串——手写 .replace 也是这个行为，helper 不改写
    expect(interpolate('a {v} b', { v: '$&' })).toBe('a {v} b');
    // $' 展开为匹配右侧的剩余文本（' b'），不是字面量——同样是手写语义
    expect(interpolate('a {v} b', { v: "$'x" })).toBe('a  bx b');
  });

  it('params 里模板没有的 key 是 no-op（与手写多余 replace 等价）', () => {
    expect(interpolate('没有占位符', { unused: 1 })).toBe('没有占位符');
    expect(interpolate('{a}', { a: 'x', b: 'y' })).toBe('x');
  });

  it('空 params 返回原模板', () => {
    expect(interpolate('{count} 项', {})).toBe('{count} 项');
  });
});
