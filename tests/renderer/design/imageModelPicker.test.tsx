// ImageModelPickerView 渲染回归：列出全部生图模型，未配 key 的标灰+提示。
// 用 renderToStaticMarkup（node 环境，无 jsdom）渲染纯展示组件，不依赖 store/i18n hook。
import { describe, it, expect } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageModelPickerView } from '../../../src/renderer/components/design/ImageModelPicker';

describe('ImageModelPickerView', () => {
  it('渲染全部模型，未配 key 的标灰+提示', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImageModelPickerView, {
        models: [
          { id: 'wanx-t2i', label: '通义万相', available: true },
          { id: 'cogview-4', label: 'CogView-4', available: false },
        ],
        value: 'wanx-t2i',
        onChange: () => {},
        unconfiguredLabel: '未配置 Key',
      }),
    );
    expect(html).toContain('通义万相');
    expect(html).toContain('CogView-4');
    expect(html).toMatch(/disabled|未配置 Key/);
  });

  it('未配 key 的 option 带 disabled 且拼上未配置提示', () => {
    const html = renderToStaticMarkup(
      React.createElement(ImageModelPickerView, {
        models: [{ id: 'cogview-4', label: 'CogView-4', available: false }],
        value: '',
        onChange: () => {},
        unconfiguredLabel: '未配置 Key',
      }),
    );
    expect(html).toContain('disabled');
    expect(html).toContain('未配置 Key');
  });
});
