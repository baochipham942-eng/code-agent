import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { PreviewErrorState, toPreviewErrorState } from '../../../src/renderer/components/PreviewPanel';

// 原 bug 形状：loadContent/handleSave 的 catch 块把三元表达式写反了——
// `err instanceof Error ? err.message : pv.xxxFailed`，导致最常见的 Error
// 实例分支反而裸露原始异常文本，只有非 Error 的冷门分支才走人话 fallback。
// toPreviewErrorState 把这个决策收口成一个函数：message 永远是调用方传入
// 的人话 fallback，不管 err 是不是 Error 实例；detail 才装原始文本。
describe('toPreviewErrorState — message 永远人话，detail 才装原始异常文本', () => {
  it('Error 实例：message 仍是人话 fallback，不是 err.message', () => {
    const err = new Error("ENOENT: no such file or directory, open '/tmp/x.md'");
    const result = toPreviewErrorState(err, '加载文件失败');
    expect(result.message).toBe('加载文件失败');
    expect(result.detail).toBe("ENOENT: no such file or directory, open '/tmp/x.md'");
  });

  it('非 Error 拒绝值：message 依旧是人话 fallback，detail 兜底转字符串', () => {
    const result = toPreviewErrorState('raw string rejection', '保存失败');
    expect(result.message).toBe('保存失败');
    expect(result.detail).toBe('raw string rejection');
  });
});

// PreviewPanel 加载/保存失败此前把 IPC 原始报错（invokeWorkspace 抛出的
// response.error.message，通常是英文异常文本）直接当 error 状态渲染。现在
// error 永远是人话摘要（loadFileFailed/saveFailed 等既有键），原始文本只
// 挂进 title tooltip——回归钉子：断言原始 detail 文本不会作为可见文本节点
// 出现，只能出现在 title="..." 属性里。
describe('PreviewErrorState — 加载/保存失败人话化', () => {
  it('展示人话摘要，原始错误文本只进 title tooltip 不裸露成可见文案', () => {
    const raw = "ENOENT: no such file or directory, open '/Users/x/broken.md'";
    const html = renderToStaticMarkup(
      <PreviewErrorState message="加载文件失败" detail={raw} onRetry={vi.fn()} />,
    );

    expect(html).toContain('加载文件失败');
    expect(html).toContain(`title="${raw.replace(/'/g, '&#x27;')}"`);
    // 原文只应该出现一次——即 title 属性里那一次，可见文本节点里不能再出现一遍
    const visibleText = html.replace(/title="[^"]*"/, '');
    expect(visibleText).not.toContain(raw);
  });

  it('没有 detail 时不渲染 title 属性', () => {
    const html = renderToStaticMarkup(
      <PreviewErrorState message="保存失败" onRetry={vi.fn()} />,
    );

    expect(html).toContain('保存失败');
    expect(html).not.toContain('title=');
  });
});
