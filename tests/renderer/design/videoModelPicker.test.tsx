// VideoModelPickerView 纯展示组件渲染冒烟（SSR）：选项 / 未配置后缀 / disabled 灰显。
// 容器（接 IPC + store）不在此测；View 无 store 依赖，可 renderToStaticMarkup 直渲。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoModelPickerView } from '../../../src/renderer/components/design/VideoModelPicker';

describe('VideoModelPickerView', () => {
  it('渲染可用/未配置模型：未配置项带后缀且 disabled', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoModelPickerView, {
        models: [
          { id: 'wan2.7-t2v', label: '通义万相 文生视频', available: true, caps: ['t2v'] },
          { id: 'wanx2.1-i2v-turbo', label: '通义万相 图生视频', available: false, caps: ['i2v'] },
        ],
        value: 'wan2.7-t2v',
        onChange: () => {},
        unconfiguredLabel: '未配置 Key',
        ariaLabel: '视频模型',
      }),
    );
    expect(html).toContain('通义万相 文生视频');
    expect(html).toContain('未配置 Key'); // 未配置项后缀
    expect(html).toContain('disabled'); // 未配置项灰显禁用
    expect(html).toContain('design-video-model'); // data-testid
  });

  it('空模型列表也不崩（IPC 未返回时的初始态）', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoModelPickerView, {
        models: [],
        value: '',
        onChange: () => {},
        unconfiguredLabel: 'x',
      }),
    );
    expect(html).toContain('select');
  });
});
