// DesignProtoHistory 渲染冒烟：左侧统一历史面板（proto 版本）在无版本时渲染空态、不崩。
// 容器读 store（SSR 下 zustand 返初始＝空 versions），故只断言面板标题 + 空态可渲染；
// 版本控件交互逻辑由 designStore 对比测试 + VersionControl/Picker 自身覆盖。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DesignProtoHistory } from '../../../src/renderer/components/design/DesignProtoHistory';

describe('DesignProtoHistory', () => {
  it('无版本时渲染历史面板标题与空态提示，不崩', () => {
    const html = renderToStaticMarkup(React.createElement(DesignProtoHistory));
    expect(html).toContain('设计历史');
    expect(html).toContain('每一步'); // historyPanelEmpty 文案片段
  });
});
